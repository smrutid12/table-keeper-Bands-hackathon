'use strict';

const { err } = require('../helpers');
const { getState } = require('../store');
const { hashPassword, verifyPassword } = require('../passwords');
const { randomId, randomToken } = require('../ids');

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

function requireString(body, field) {
  const v = body[field];
  if (v === undefined || v === null) throw err(422, 'validation_failed', `${field} is required`);
  if (typeof v !== 'string') throw err(400, 'malformed_request', `${field} must be a string`);
  return v;
}

function signup(body) {
  const email = requireString(body, 'email');
  const password = requireString(body, 'password');
  const displayName = requireString(body, 'display_name');

  if (!EMAIL_RE.test(email)) throw err(422, 'validation_failed', 'email must be of the form local@domain');
  if (password.length < 8) throw err(422, 'validation_failed', 'password must be at least 8 characters');

  const state = getState();
  const lower = email.toLowerCase();
  if (state.emailIndex.has(lower)) throw err(409, 'email_taken', 'Email already registered');

  const id = randomId('u');
  const user = { id, email, password_hash: hashPassword(password), display_name: displayName };
  state.users.set(id, user);
  state.emailIndex.set(lower, id);

  const token = randomToken();
  state.tokens.set(token, id);

  return { status: 201, body: { user_id: id, display_name: user.display_name, token } };
}

function login(body) {
  const email = requireString(body, 'email');
  const password = requireString(body, 'password');

  const state = getState();
  const userId = state.emailIndex.get(email.toLowerCase());
  const user = userId ? state.users.get(userId) : null;
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw err(401, 'unauthenticated', 'Wrong password or unknown email');
  }

  const token = randomToken();
  state.tokens.set(token, user.id);

  return { status: 200, body: { user_id: user.id, display_name: user.display_name, token } };
}

module.exports = { signup, login };
