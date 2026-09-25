// Proof-of-correctness script. Run it live in your demo.
// 1) 100 different guests race for one slot  -> exactly (# fitting tables) succeed, 0 errors.
// 2) One request replayed 30x concurrently    -> exactly 1 reservation, identical responses.
// 3) Garbage inputs                          -> documented 4xx, never 500.
// 4) DST gap / overlap times                 -> explicit 422s.
import { DateTime } from 'luxon';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const date = DateTime.now().setZone('America/New_York').plus({ days: 7 }).toISODate();
let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };

const book = (body, key) => fetch(`${BASE}/reservations`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key && { 'Idempotency-Key': key }) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json() }));

// 1. Stampede
const slot = { restaurant_id: 'r1', date, time: '19:00', party_size: 4 };
const results = await Promise.all(Array.from({ length: 100 }, (_, i) =>
  book({ ...slot, guest_name: `Guest ${i}` }, `stampede-${Date.now()}-${i}`)));
const won = results.filter(r => r.status === 201);
const tables = new Set(won.map(r => r.body.table_id));
check(won.length === 3, `stampede: ${won.length} of 100 got a table (expected 3: T2, T3, T4)`);
check(tables.size === won.length, 'stampede: every winner got a different table');
check(results.every(r => r.status === 201 || r.status === 409), 'stampede: all others got 409, no 500s');

// 2. Replay storm
const key = `replay-${Date.now()}`;
const replay = { ...slot, time: '17:00', guest_name: 'Replay Rita' };
const reps = await Promise.all(Array.from({ length: 30 }, () => book(replay, key)));
const ids = new Set(reps.map(r => r.body.id));
check(ids.size === 1 && reps.every(r => r.status === 201), `replay: 30 retries -> ${ids.size} reservation`);
const reused = await book({ ...replay, party_size: 2 }, key);
check(reused.status === 422 && reused.body.error.code === 'idempotency_key_reused', 'replay: same key + different body -> 422');

// 3. Malformed input
for (const [label, body] of [
  ['not JSON', '{oops'], ['array body', '[]'], ['party_size as string', { ...slot, party_size: '4', guest_name: 'x' }],
  ['bad time', { ...slot, time: '25:99', guest_name: 'x' }], ['missing fields', {}],
  ['unknown restaurant', { ...slot, restaurant_id: 'nope', guest_name: 'x' }],
]) {
  const r = await book(body);
  check(r.status >= 400 && r.status < 500 && r.body.error?.code, `malformed (${label}) -> ${r.status} ${r.body.error?.code}`);
}

// 4. Time zones (r2 is a 24h diner in New York).
const gap = await book({ restaurant_id: 'r2', date: '2027-03-14', time: '02:30', party_size: 2, guest_name: 'x' });
check(gap.body.error?.code === 'nonexistent_local_time', `time: 2027-03-14 02:30 NY (spring-forward gap) -> ${gap.status} ${gap.body.error?.code}`);
const overlap = await book({ restaurant_id: 'r2', date: '2026-11-01', time: '01:30', party_size: 2, guest_name: 'x' });
check(overlap.body.error?.code === 'ambiguous_local_time', `time: 2026-11-01 01:30 NY (fall-back overlap) -> ${overlap.status} ${overlap.body.error?.code}`);
const past = await book({ ...slot, date: '2020-01-01', guest_name: 'Marty McFly' });
check(past.body.error?.code === 'in_past', `time: booking in the past -> ${past.status} in_past`);

console.log(failed ? '\nSome checks failed.' : '\nAll checks passed. No table was double-booked.');
process.exit(failed ? 1 : 0);
