'use strict';

const { getState } = require('./store');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function err(status, code, message) {
  return new ApiError(status, code, message || code);
}

function errorBody(e) {
  return { error: { code: e.code, message: e.message } };
}

// Parses raw body bytes as a JSON object. Throws ApiError(400) if it does
// not parse, or does not parse to a plain JSON object.
function parseJsonObject(raw) {
  if (!raw || raw.length === 0) return {};
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw err(400, 'malformed_request', 'Body is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw err(400, 'malformed_request', 'Body must be a JSON object');
  }
  return value;
}

function authenticate(headers) {
  const h = headers['authorization'];
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;
  const state = getState();
  const userId = state.tokens.get(token);
  if (!userId) return null;
  const user = state.users.get(userId);
  if (!user) return null;
  return user;
}

function requireAuth(headers) {
  const user = authenticate(headers);
  if (!user) throw err(401, 'unauthenticated', 'Missing, malformed or unknown bearer token');
  return user;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isIntegerLike(v) {
  return typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v);
}

module.exports = {
  ApiError, err, errorBody, parseJsonObject, authenticate, requireAuth,
  isPlainObject, isIntegerLike,
};
