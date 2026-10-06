'use strict';

const { err } = require('../helpers');
const store = require('../store');

function reset(parsedBody) {
  store.resetState(parsedBody || {});
  return { status: 204, body: null };
}

function exportData() {
  return { status: 200, body: store.exportState() };
}

function importData(parsedBody) {
  const ok = store.importState(parsedBody);
  if (!ok) throw err(422, 'validation_failed', 'Invalid export object: bad track/version/state shape');
  return { status: 204, body: null };
}

module.exports = { reset, exportData, importData };
