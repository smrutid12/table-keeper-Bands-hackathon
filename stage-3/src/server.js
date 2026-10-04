'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { ApiError, err, errorBody, parseJsonObject, requireAuth } = require('./helpers');
const restaurantsHandlers = require('./handlers/restaurants');
const authHandlers = require('./handlers/auth');
const reservationHandlers = require('./handlers/reservations');
const { reservationMoves } = require('./handlers/reservationMoves');
const seriesHandlers = require('./handlers/series');
const testControl = require('./handlers/testControl');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function staticFile(name, contentType) {
  const body = fs.readFileSync(path.join(PUBLIC_DIR, name));
  return { public: true, raw: true, contentType, handle: () => ({ status: 200, body }) };
}

const routes = [
  { method: 'GET', pattern: /^\/health$/, public: true, handle: () => ({ status: 200, body: { status: 'ok' } }) },

  { method: 'GET', pattern: /^\/$/, ...staticFile('index.html', 'text/html; charset=utf-8') },
  { method: 'GET', pattern: /^\/signup$/, ...staticFile('signup.html', 'text/html; charset=utf-8') },
  { method: 'GET', pattern: /^\/login$/, ...staticFile('login.html', 'text/html; charset=utf-8') },
  { method: 'GET', pattern: /^\/lookup$/, ...staticFile('lookup.html', 'text/html; charset=utf-8') },
  { method: 'GET', pattern: /^\/app\.css$/, ...staticFile('app.css', 'text/css; charset=utf-8') },
  { method: 'GET', pattern: /^\/app\.js$/, ...staticFile('app.js', 'text/javascript; charset=utf-8') },

  { method: 'POST', pattern: /^\/_test\/reset$/, public: true, handle: (ctx) => testControl.reset(ctx.parsedBody) },
  { method: 'GET', pattern: /^\/_test\/export$/, public: true, handle: () => testControl.exportData() },
  { method: 'POST', pattern: /^\/_test\/import$/, public: true, handle: (ctx) => testControl.importData(ctx.parsedBody) },

  { method: 'GET', pattern: /^\/restaurants$/, public: true, handle: () => restaurantsHandlers.listRestaurants() },
  { method: 'GET', pattern: /^\/restaurants\/([^/]+)$/, public: true, handle: (ctx) => restaurantsHandlers.getRestaurant({ id: decodeURIComponent(ctx.params[0]) }) },
  { method: 'GET', pattern: /^\/availability$/, public: true, handle: (ctx) => restaurantsHandlers.getAvailability(ctx.query) },
  { method: 'POST', pattern: /^\/restaurants\/([^/]+)\/policies$/, public: false, handle: (ctx) => restaurantsHandlers.publishPolicy(ctx.user, ctx.headers, decodeURIComponent(ctx.params[0]), ctx.parsedBody) },
  { method: 'GET', pattern: /^\/restaurants\/([^/]+)\/policies$/, public: true, handle: (ctx) => restaurantsHandlers.listPolicies(decodeURIComponent(ctx.params[0])) },

  { method: 'POST', pattern: /^\/auth\/signup$/, public: true, handle: (ctx) => authHandlers.signup(ctx.parsedBody) },
  { method: 'POST', pattern: /^\/auth\/login$/, public: true, handle: (ctx) => authHandlers.login(ctx.parsedBody) },

  { method: 'POST', pattern: /^\/reservations$/, public: false, handle: (ctx) => reservationHandlers.createReservation(ctx.user, ctx.headers, ctx.rawBody, ctx.parsedBody) },
  { method: 'GET', pattern: /^\/reservations$/, public: false, handle: (ctx) => reservationHandlers.listReservations(ctx.user) },
  { method: 'GET', pattern: /^\/reservations\/([^/]+)\/history$/, public: true, handle: (ctx) => reservationHandlers.getReservationHistory(ctx.headers, decodeURIComponent(ctx.params[0])) },
  { method: 'GET', pattern: /^\/reservations\/([^/]+)\/decision$/, public: true, handle: (ctx) => reservationHandlers.getReservationDecision(ctx.headers, decodeURIComponent(ctx.params[0])) },
  { method: 'GET', pattern: /^\/reservations\/([^/]+)$/, public: false, handle: (ctx) => reservationHandlers.getReservation(ctx.user, decodeURIComponent(ctx.params[0])) },
  { method: 'POST', pattern: /^\/reservations\/([^/]+)\/cancel$/, public: false, handle: (ctx) => reservationHandlers.cancelReservation(ctx.user, decodeURIComponent(ctx.params[0])) },
  { method: 'PATCH', pattern: /^\/reservations\/([^/]+)$/, public: false, handle: (ctx) => reservationHandlers.amendReservation(ctx.user, decodeURIComponent(ctx.params[0]), ctx.parsedBody) },

  { method: 'POST', pattern: /^\/reservation-moves$/, public: false, handle: (ctx) => reservationMoves(ctx.user, ctx.headers, ctx.parsedBody) },

  { method: 'POST', pattern: /^\/series$/, public: false, handle: (ctx) => seriesHandlers.createSeries(ctx.user, ctx.headers, ctx.parsedBody) },
  { method: 'GET', pattern: /^\/series\/([^/]+)$/, public: true, handle: (ctx) => seriesHandlers.getSeries(ctx.headers, decodeURIComponent(ctx.params[0])) },
];

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(pathname);
    if (m) return { route: r, params: m.slice(1) };
  }
  return null;
}

function sendRaw(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
  });
  res.end(body);
}

function sendJSON(res, status, obj) {
  if (obj === null || obj === undefined) {
    res.writeHead(status, { 'Content-Length': '0' });
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 10 * 1024 * 1024;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(err(400, 'malformed_request', 'Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (e) => reject(e));
  });
}

async function handleRequest(req, res) {
  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (e) {
    if (e instanceof ApiError) return sendJSON(res, e.status, errorBody(e));
    return sendJSON(res, 400, errorBody(err(400, 'malformed_request', 'Could not read request body')));
  }

  const url = new URL(req.url, 'http://localhost');
  const match = matchRoute(req.method, url.pathname);
  if (!match) {
    return sendJSON(res, 404, errorBody(err(404, 'not_found', 'No such route')));
  }
  const { route, params } = match;

  // Everything below this point, through state mutation, is synchronous:
  // no awaits occur inside parsing/validation/business-logic, so each
  // request's critical section runs to completion without interleaving
  // with any other request. This is what gives us atomicity.
  try {
    let parsedBody = {};
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
      parsedBody = parseJsonObject(rawBody);
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;

    const user = route.public ? null : requireAuth(headers);

    const ctx = {
      params, query: url.searchParams, headers, rawBody, parsedBody, user,
    };

    const result = route.handle(ctx);
    if (route.raw) return sendRaw(res, result.status, route.contentType, result.body);
    return sendJSON(res, result.status, result.body);
  } catch (e) {
    if (e instanceof ApiError) {
      return sendJSON(res, e.status, errorBody(e));
    }
    // eslint-disable-next-line no-console
    console.error('Unexpected error:', e);
    return sendJSON(res, 500, { error: { code: 'internal_error', message: 'Unexpected error' } });
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('Unhandled error:', e);
    try {
      sendJSON(res, 500, { error: { code: 'internal_error', message: 'Unexpected error' } });
    } catch (_) { /* response may already be closed */ }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`tablekeeper listening on 0.0.0.0:${PORT}`);
});

process.on('uncaughtException', (e) => {
  // eslint-disable-next-line no-console
  console.error('uncaughtException:', e);
});
process.on('unhandledRejection', (e) => {
  // eslint-disable-next-line no-console
  console.error('unhandledRejection:', e);
});
