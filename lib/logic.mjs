// Pure scheduling logic: intervals, clash checks, day load, free slots, stats.
// The AI never decides any of this. It only turns your sentence into fields.
import { MIN, dayKey, atMin, addDays, fmtT, fmtD } from './time.mjs';

export const REASONS = [
  'Previous thing ran long', 'Left late', 'Travel took longer', 'Plan cancelled',
  'Change of plans', 'Said yes too fast', 'Forgot', 'Other',
];
export const DEFAULT_SETTINGS = { winStart: 540, winEnd: 1200, briefMin: 510, eveMin: 1260 };

export const isOpen = (it) =>
  (it.type === 'promise' && it.status === 'pending') ||
  (it.type === 'task' && (it.status === 'todo' || it.status === 'doing'));

export const label = (it) => `“${it.title.length > 26 ? it.title.slice(0, 25) + '…' : it.title}”`;

export function interval(it, now) {
  if (it.type === 'promise') {
    if (it.kind === 'deliver') return { s: it.dueAt - (it.work || 0) * MIN, e: it.dueAt };
    return { s: it.dueAt - (it.travel || 0) * MIN, e: it.dueAt + (it.stay || 0) * MIN };
  }
  if (it.status === 'doing' && it.startedAt) return { s: it.startedAt, e: Math.max(it.startedAt + it.est * MIN, now) };
  if (it.startAt) return { s: it.startAt, e: it.startAt + it.est * MIN };
  return null;
}

/** Mark nudge windows that already passed when an item is created, so nothing stale fires. */
export function initFlags(it, now) {
  const n = (it.n = it.n || {});
  if (it.type !== 'promise') return;
  if (it.kind === 'place' && it.travel > 0) {
    const leaveAt = it.dueAt - it.travel * MIN;
    if (now >= leaveAt - 5 * MIN) n.pre = now;
    if (now >= leaveAt) n.leave = now;
  } else if (it.kind === 'place') {
    if (now >= it.dueAt - 10 * MIN) n.pre = now;
  } else if (now >= it.dueAt - (it.work || 0) * MIN) n.pre = now;
}

export function load(items, now, st) {
  const key = dayKey(now);
  const ws = atMin(key, st.winStart), we = atMin(key, st.winEnd);
  const left = Math.max(0, (we - Math.max(now, ws)) / MIN);
  let committed = 0;
  for (const it of items) {
    if (!isOpen(it)) continue;
    if (it.type === 'task') {
      if (it.status === 'doing') committed += Math.max(0, it.est - (now - it.startedAt) / MIN);
      else if (!it.startAt || dayKey(it.startAt) === key) committed += it.est;
    } else {
      const iv = interval(it, now);
      if (dayKey(iv.s) === key || dayKey(iv.e) === key) committed += Math.max(0, (iv.e - Math.max(iv.s, now)) / MIN);
    }
  }
  return { committed, left };
}

/** cand = { s, e, add } with s/e in ms (or null) and add in minutes. Returns { lvl, msgs }. */
export function check(cand, items, now, st, selfId) {
  const msgs = []; let lvl = 'ok';
  const bump = (l) => { if (l === 'bad') lvl = 'bad'; else if (l === 'warn' && lvl === 'ok') lvl = 'warn'; };
  if (cand.s != null) {
    for (const it of items) {
      if (!isOpen(it) || it.id === selfId) continue;
      const iv = interval(it, now);
      if (!iv) continue;
      if (cand.s < iv.e && cand.e > iv.s) { msgs.push(['bad', `Overlaps ${label(it)}, ${fmtT(iv.s)}–${fmtT(iv.e)}.`]); bump('bad'); }
      else {
        const before = (cand.s - iv.e) / MIN, after = (iv.s - cand.e) / MIN;
        if (before >= 0 && before < 15) { msgs.push(['warn', `Only ${Math.round(before)} min after ${label(it)}.`]); bump('warn'); }
        if (after >= 0 && after < 15) { msgs.push(['warn', `Only ${Math.round(after)} min before ${label(it)} starts.`]); bump('warn'); }
      }
    }
    if (cand.s < now - MIN) { msgs.push(['bad', 'That start time has already passed.']); bump('bad'); }
  }
  const sameDay = cand.s == null || dayKey(cand.s) === dayKey(now);
  if (sameDay) {
    const L = load(items.filter((i) => i.id !== selfId), now, st);
    const total = L.committed + cand.add;
    if (L.left <= 0) { msgs.push(['warn', 'Your day window has ended.']); bump('warn'); }
    else if (total > L.left + 0.5) { msgs.push(['bad', `Your day would be ${fmtD(total - L.left)} over the time you have left.`]); bump('bad'); }
    else if (total / L.left > 0.85) { msgs.push(['warn', `Only ${fmtD(L.left - total)} of slack would remain.`]); bump('warn'); }
    else msgs.push(['info', `${fmtD(Math.max(0, L.left - total))} of slack would remain.`]);
  }
  return { lvl, msgs };
}

/** First gap that fits `est` minutes today, else the start of tomorrow's window. */
export function findSlot(items, est, now, st, selfId) {
  const five = 5 * MIN;
  for (let off = 0; off <= 1; off++) {
    const key = addDays(dayKey(now), off);
    const ws = atMin(key, st.winStart), we = atMin(key, st.winEnd);
    let cur = off === 0 ? Math.max(Math.ceil(now / five) * five, ws) : ws;
    const ivs = items
      .filter((i) => isOpen(i) && i.id !== selfId)
      .map((i) => interval(i, now)).filter(Boolean)
      .filter((iv) => iv.e > ws && iv.s < we)
      .sort((a, b) => a.s - b.s);
    for (const iv of ivs) {
      if (iv.e <= cur) continue;
      if (cur + est * MIN <= iv.s - five) break;
      cur = Math.max(cur, Math.ceil((iv.e + five) / five) * five);
    }
    if (cur + est * MIN <= we) return { ms: cur, off };
  }
  return null;
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
/** Learn usual travel time and task length from history. */
export function defaults(items) {
  const trav = items.filter((i) => i.type === 'promise' && i.kind === 'place' && i.travel > 0 && i.status !== 'held').map((i) => i.travel);
  const est = items.filter((i) => i.type === 'task' && i.est > 0).map((i) => i.est);
  return { travel: trav.length >= 3 ? median(trav) : null, est: est.length >= 3 ? median(est) : 30 };
}

export function stats(items) {
  const s = { kept: 0, late: 0, missed: 0, unknown: 0, lateMin: 0, tasks: 0, done: 0, est: 0, act: 0, measured: 0, reasons: {} };
  for (const it of items) {
    if (it.type === 'promise') {
      if (it.status === 'ontime') s.kept++;
      else if (it.status === 'late') { s.late++; s.lateMin += it.lateBy || 0; }
      else if (it.status === 'missed') s.missed++;
      else if (it.status === 'unknown') s.unknown++;
      if ((it.status === 'late' || it.status === 'missed') && it.why) s.reasons[it.why] = (s.reasons[it.why] || 0) + 1;
    } else if (it.status !== 'held' && it.status !== 'carried') {
      s.tasks++;
      if (it.status === 'done') { s.done++; if (it.actual) { s.measured++; s.est += it.est; s.act += it.actual; } }
      if (it.status === 'skipped' && it.why) s.reasons[it.why] = (s.reasons[it.why] || 0) + 1;
    }
  }
  s.resolved = s.kept + s.late + s.missed;
  return s;
}

/** Promises kept in a row, newest first. Cancelled and unknown are skipped. */
export function streak(items) {
  const res = items.filter((i) => i.type === 'promise' && ['ontime', 'late', 'missed'].includes(i.status))
    .sort((a, b) => b.dueAt - a.dueAt);
  let n = 0;
  for (const p of res) { if (p.status === 'ontime') n++; else break; }
  return n;
}
