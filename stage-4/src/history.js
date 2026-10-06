'use strict';

const time = require('./time');

function tableChangeField(tableIds) {
  return tableIds.length === 1 ? 'table_id' : 'table_ids';
}

function tableChangeValue(tableIds) {
  return tableIds.length === 1 ? tableIds[0] : tableIds.slice();
}

function sameTableIds(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

// Changes for a brand-new reservation: all fields, "from": null, in the
// fixed order table_id/table_ids, starts_at_local, party_size.
function changesForCreate({ tableIds, startsAtLocal, partySize }) {
  return [
    { field: tableChangeField(tableIds), from: null, to: tableChangeValue(tableIds) },
    { field: 'starts_at_local', from: null, to: startsAtLocal },
    { field: 'party_size', from: null, to: partySize },
  ];
}

// Changes between an old and new state: only fields that actually differ,
// in the order table_id/table_ids, starts_at_local, party_size. Either side
// being a pair (2 tables) uses table_ids with complete before/after lists;
// both-single uses table_id. A reversed pair naming the same set is not a
// change (resolveTableSet already canonicalizes pair order).
function changesForUpdate(oldState, newState) {
  const changes = [];
  if (!sameTableIds(oldState.tableIds, newState.tableIds)) {
    if (oldState.tableIds.length === 1 && newState.tableIds.length === 1) {
      changes.push({ field: 'table_id', from: oldState.tableIds[0], to: newState.tableIds[0] });
    } else {
      changes.push({ field: 'table_ids', from: oldState.tableIds.slice(), to: newState.tableIds.slice() });
    }
  }
  if (oldState.startsAtLocal !== newState.startsAtLocal) {
    changes.push({ field: 'starts_at_local', from: oldState.startsAtLocal, to: newState.startsAtLocal });
  }
  if (oldState.partySize !== newState.partySize) {
    changes.push({ field: 'party_size', from: oldState.partySize, to: newState.partySize });
  }
  return changes;
}

// Appends a history entry reflecting the reservation's state *after* the
// caller has already applied revision/accepted_terms for this event.
function appendHistory(reservation, event, changes, planId) {
  const entry = {
    seq: reservation.history.length + 1,
    at_ms: Date.now(),
    event,
    changes,
    revision: reservation.revision,
    accepted_terms: reservation.accepted_terms,
  };
  if (planId !== undefined) entry.plan_id = planId;
  reservation.history.push(entry);
}

function serializeHistoryEntry(entry) {
  const out = {
    seq: entry.seq,
    at: time.formatUtcRfc3339(entry.at_ms),
    event: entry.event,
    changes: entry.changes,
    revision: entry.revision,
    accepted_terms: entry.accepted_terms,
  };
  if (entry.plan_id !== undefined) out.plan_id = entry.plan_id;
  return out;
}

module.exports = {
  changesForCreate, changesForUpdate, appendHistory, serializeHistoryEntry, sameTableIds,
};
