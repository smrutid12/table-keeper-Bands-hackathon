'use strict';

const { err } = require('./helpers');
const { canonicalJSON } = require('./store');

function compositeKey(userId, method, path, key) {
  return `${userId}\u0000${method}\u0000${path}\u0000${key}`;
}

function requireIdempotencyKey(headers) {
  const raw = headers['idempotency-key'];
  if (raw === undefined || raw === null || raw === '') {
    throw err(400, 'missing_idempotency_key', 'Idempotency-Key header is required');
  }
  const key = String(raw);
  if (key.length < 1 || key.length > 255) {
    throw err(422, 'validation_failed', 'Idempotency-Key must be 1 to 255 characters');
  }
  return key;
}

// Resolves idempotency before endpoint-specific validation, per spec.
// Returns { replay: {status, body} } if this is a replay to short-circuit
// with, or { ck } (composite key) to proceed and later commit() with.
function resolveIdempotency(state, userId, method, path, key, parsedBody) {
  const ck = compositeKey(userId, method, path, key);
  const existing = state.idempotency.get(ck);
  if (!existing) return { ck };
  const bodyNow = canonicalJSON(parsedBody);
  if (bodyNow === existing.bodyCanonical) {
    return { replay: { status: 200, body: existing.responseBody } };
  }
  throw err(409, 'idempotency_key_reuse', 'Idempotency key already used with a different request body');
}

function commitIdempotency(state, ck, parsedBody, responseBody) {
  state.idempotency.set(ck, {
    bodyCanonical: canonicalJSON(parsedBody),
    responseBody,
  });
}

module.exports = { requireIdempotencyKey, resolveIdempotency, commitIdempotency };
