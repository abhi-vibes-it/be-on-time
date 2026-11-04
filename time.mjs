// Time helpers. Everything is stored as epoch milliseconds; "local" means the
// owner's fixed UTC offset (India has no daylight saving, so a fixed offset is exact).
export const TZ_MIN = Number(process.env.TZ_OFFSET_MIN ?? 330);
export const MIN = 60000;
export const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

export function parts(ms) {
  const d = new Date(ms + TZ_MIN * MIN);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay(),
    min: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}
export const dayKey = (ms) => { const p = parts(ms); return `${p.y}${pad(p.mo)}${pad(p.d)}`; };
export const dayStart = (key) => Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8)) - TZ_MIN * MIN;
export const addDays = (key, n) => dayKey(dayStart(key) + n * DAY + 12 * 60 * MIN);
export const atMin = (key, min) => dayStart(key) + min * MIN;
export const keyFromId = (id) => '20' + id.slice(0, 6);
export const newId = (anchorMs) => dayKey(anchorMs).slice(2) + Math.random().toString(36).slice(2, 6);

export function fmtMin(m) {
  m = ((Math.round(m) % 1440) + 1440) % 1440;
  let h = Math.floor(m / 60); const mi = m % 60;
  const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
  return `${h}:${pad(mi)} ${ap}`;
}
export const fmtT = (ms) => fmtMin(parts(ms).min);
export function fmtD(m) {
  m = Math.round(m);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${pad(r)}m` : `${h}h`;
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(ms) { const p = parts(ms); return `${DOW[p.dow]} ${p.d} ${MON[p.mo - 1]}`; }
export function parseHM(s) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(s).trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

/**
 * Turn a spoken clock time ("1", "1:30", "3 pm", "14:30") into a timestamp.
 * With no am/pm we pick the next sensible daytime occurrence, because people say "at 1".
 */
export function resolveClock(t, now, dayOffset = 0) {
  const base = addDays(dayKey(now), dayOffset);
  const h = Number(t.h), m = Number(t.m || 0);
  let cands;
  if (h >= 13 || h === 0) cands = [(h % 24) * 60 + m];
  else if (t.mer === 'am') cands = [(h % 12) * 60 + m];
  else if (t.mer === 'pm') cands = [(h % 12) * 60 + 720 + m];
  else cands = [(h % 12) * 60 + m, (h % 12) * 60 + 720 + m];
  const assumed = cands.length > 1;
  if (assumed) {
    const day = cands.filter((c) => c >= 360);
    const pool = day.length ? day : cands;
    const pick = dayOffset === 0 ? pool.find((c) => atMin(base, c) >= now - 5 * MIN) : pool[0];
    if (pick === undefined) return { ms: atMin(addDays(base, 1), pool[0]), assumed, rolled: true };
    return { ms: atMin(base, pick), assumed, rolled: false };
  }
  const only = cands[0];
  if (dayOffset === 0 && atMin(base, only) < now - 5 * MIN) {
    return { ms: atMin(addDays(base, 1), only), assumed, rolled: true };
  }
  return { ms: atMin(base, only), assumed, rolled: false };
}
