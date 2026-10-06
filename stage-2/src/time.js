'use strict';

// Timezone math built on Intl, no external deps. Handles IANA zones,
// including DST gaps (spring forward) and folds (fall back).

const DTF_CACHE = new Map();

function getFormatter(zone) {
  let f = DTF_CACHE.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    DTF_CACHE.set(zone, f);
  }
  return f;
}

// Returns the wall-clock components (y, mo, d, h, mi, s) that `zone` shows
// at the real UTC instant `utcMs`.
function localPartsAt(zone, utcMs) {
  const parts = getFormatter(zone).formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    y: Number(map.year), mo: Number(map.month), d: Number(map.day),
    h: Number(map.hour) === 24 ? 0 : Number(map.hour),
    mi: Number(map.minute), s: Number(map.second),
  };
}

// Offset in minutes (east positive) in effect in `zone` at real UTC instant `utcMs`.
function offsetMinutesAt(zone, utcMs) {
  const p = localPartsAt(zone, utcMs);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - utcMs) / 60000);
}

function sameWallClock(a, b) {
  return a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi;
}

// Resolves a local wall-clock time (y, mo, d, h, mi) in `zone` to a UTC
// instant. Returns { utcMs, offsetMinutes } or null if the local time does
// not exist (DST gap). On a fold (ambiguous, repeated hour) resolves to the
// earlier instant (the occurrence before the clocks change), per spec.
function localToUtc(zone, y, mo, d, h, mi) {
  const target = { y, mo, d, h, mi };
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const dayMs = 24 * 3600 * 1000;
  const offsetBefore = offsetMinutesAt(zone, guess - dayMs);
  const offsetAfter = offsetMinutesAt(zone, guess + dayMs);

  const offsets = offsetBefore === offsetAfter ? [offsetBefore] : [offsetBefore, offsetAfter];
  const valid = [];
  for (const off of offsets) {
    const utcMs = guess - off * 60000;
    const local = localPartsAt(zone, utcMs);
    if (sameWallClock(local, target)) {
      valid.push({ utcMs, offsetMinutes: off });
    }
  }

  if (valid.length === 0) return null; // gap: local time does not exist
  if (valid.length === 1) return valid[0];
  // fold: two valid instants map to this local wall clock. Pick the one
  // with the larger offset: that is the earlier UTC instant, i.e. the
  // occurrence before the clocks change.
  valid.sort((a, b) => b.offsetMinutes - a.offsetMinutes);
  return valid[0];
}

function pad2(n) { return String(n).padStart(2, '0'); }

function formatOffset(offsetMinutes) {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

// Full RFC3339 string for a UTC instant, rendered in `zone`'s local wall clock.
function formatRfc3339(zone, utcMs) {
  const p = localPartsAt(zone, utcMs);
  const offset = offsetMinutesAt(zone, utcMs);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}${formatOffset(offset)}`;
}

function formatUtcRfc3339(utcMs) {
  return formatRfc3339('UTC', utcMs);
}

function weekdayOf(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][wd];
}

function isValidCalendarDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function hhmmToMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

module.exports = {
  offsetMinutesAt, localToUtc, formatRfc3339, formatUtcRfc3339,
  weekdayOf, isValidCalendarDate, hhmmToMinutes, localPartsAt,
};
