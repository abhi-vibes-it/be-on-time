// Telegram conversation logic: messages in, replies and button taps out.
import { MIN, dayKey, resolveClock, newId, fmtT, fmtD, fmtDate, parseHM, fmtMin } from './time.mjs';
import { interval, isOpen, initFlags, check, findSlot, load, defaults, stats, streak, REASONS } from './logic.mjs';
import { getMeta, setMeta, getItem, putItem, delItem, loadAround } from './store.mjs';
import { parseMessage } from './parse.mjs';
import { send, edit, answer, btn, esc, transcribe } from './tg.mjs';

const T = (it) => `<b>${esc(it.title)}</b>`;
const dayPrefix = (ms, now) => (dayKey(ms) === dayKey(now) ? '' : `${fmtDate(ms)} `);

function describe(it, now) {
  if (it.type === 'promise') {
    if (it.kind === 'deliver') return `${dayPrefix(it.dueAt, now)}due ${fmtT(it.dueAt)}`;
    let s = `${dayPrefix(it.dueAt, now)}${fmtT(it.dueAt)}`;
    if (it.travel > 0) s += ` · leave ${fmtT(it.dueAt - it.travel * MIN)} (${fmtD(it.travel)} travel)`;
    if (it.stay > 0) s += ` · stay ${fmtD(it.stay)}`;
    return s;
  }
  return it.startAt ? `${dayPrefix(it.startAt, now)}${fmtT(it.startAt)} · ${fmtD(it.est)}` : fmtD(it.est);
}
const whyRows = (id) => {
  const rows = [];
  for (let i = 0; i < REASONS.length; i += 2) rows.push(REASONS.slice(i, i + 2).map((r, j) => btn(r, `W:${id}:${i + j}`)));
  rows.push([btn('Skip', `W:${id}:99`)]);
  return rows;
};
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

const HELP = `<b>How this works</b>
Just tell me things, by typing or with your keyboard's mic:
• “coffee with a friend at 3, 20 min away”
• “review the draft, 45 mins”
• “send the report by 5, about an hour of work left”

I check it against your day before you say yes, slot tasks into free gaps, and nudge you when it's time to leave or start. Then I ask one thing: did you make it?

Fix mistakes in plain words: “make that 30”, “it's 15 min away”, “cancel the coffee”.
Also: /today, /review, /day 09:00 20:00, /brief 08:30, /evening 21:00`;

/* ---------- entry point ---------- */
export async function handleUpdate(update, now = Date.now()) {
  if (update.callback_query) return handleCallback(update.callback_query, now);
  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chat = msg.chat.id;
  const meta = await getMeta();
  const owner = process.env.OWNER_CHAT_ID || meta.owner;
  let text = (msg.text || '').trim();
  if (!owner) {
    if (!text.startsWith('/start')) return;
    meta.owner = chat; await setMeta(meta);
    return send(chat, `Hi, I'm Abhi On Time. I'm now yours alone and ignore everyone else.\n\n${HELP}`);
  }
  if (String(chat) !== String(owner)) return;

  let heard = '';
  if (!text && (msg.voice || msg.audio)) {
    const t = await transcribe((msg.voice || msg.audio).file_id);
    if (!t) return send(chat, "I couldn't read that voice note. Tap the mic on your keyboard and send the text instead.");
    text = t; heard = `🎙 <i>${esc(t)}</i>\n\n`;
  }
  if (!text) return;
  if (text.startsWith('/start') || text.startsWith('/help')) return send(chat, HELP);

  const cmd = /^\/(day|brief|evening)\b\s*(.*)$/i.exec(text);
  if (cmd) return settingsCommand(chat, meta, cmd[1].toLowerCase(), cmd[2]);

  const parsed = await parseMessage(text.replace(/^\//, ''), now);
  switch (parsed.intent) {
    case 'add': return addFlow(chat, parsed, now, meta, heard);
    case 'update_last': return updateLast(chat, parsed.patch, now, meta);
    case 'cancel': return cancelFlow(chat, parsed.target, now, meta);
    case 'show_today': return send(chat, await renderToday(now, meta.settings));
    case 'review': return send(chat, await renderReview(now));
    default: return send(chat, HELP);
  }
}

async function settingsCommand(chat, meta, which, arg) {
  const s = meta.settings;
  const a = arg.split(/\s+/).filter(Boolean).map(parseHM);
  if (which === 'day') {
    if (a.length !== 2 || a.includes(null) || a[1] <= a[0]) return send(chat, 'Use: /day 09:00 20:00');
    s.winStart = a[0]; s.winEnd = a[1];
  } else {
    if (a.length !== 1 || a[0] == null) return send(chat, `Use: /${which} ${which === 'brief' ? '08:30' : '21:00'}`);
    if (which === 'brief') s.briefMin = a[0]; else s.eveMin = a[0];
  }
  await setMeta(meta);
  return send(chat, `Saved. Day ${fmtMin(s.winStart)}–${fmtMin(s.winEnd)}, morning note ${fmtMin(s.briefMin)}, evening wrap ${fmtMin(s.eveMin)}.`);
}

/* ---------- adding things ---------- */
export async function addFlow(chat, parsed, now, meta, heard = '') {
  const st = meta.settings;
  const all = await loadAround(now, 14, 2);
  const def = defaults(all);
  const created = [];
  const blocks = [];
  const rows = [];
  const ordered = [...parsed.items.filter((i) => i.type === 'promise'), ...parsed.items.filter((i) => i.type !== 'promise')];

  for (const p of ordered) {
    const notes = [];
    if (p.type === 'promise') {
      if (p.inMin == null && !p.time) { blocks.push(`❓ ${T(p)}: what time did you promise?`); continue; }
      let dueAt;
      if (p.inMin != null) dueAt = now + p.inMin * MIN;
      else {
        const r = resolveClock(p.time, now, p.dayOffset || 0);
        dueAt = r.ms;
        if (r.assumed) notes.push(`read as ${fmtT(r.ms)}`);
        if (r.rolled) notes.push("that's tomorrow");
      }
      const kind = p.kind === 'deliver' ? 'deliver' : 'place';
      let travel = 0, work = 0;
      const stay = p.stayMin ?? 0;
      if (kind === 'place') {
        if (p.travelMin != null) travel = p.travelMin;
        else if (def.travel) { travel = def.travel; notes.push(`assumed ${fmtD(travel)} travel, your usual`); }
        else notes.push('no travel time given. Say "20 min away" if it takes time');
      } else { work = p.workMin ?? 30; if (p.workMin == null) notes.push('assumed 30m of work left'); }
      const it = { id: newId(dueAt), type: 'promise', kind, title: p.title, dueAt, travel, stay, work, status: 'pending', created: now, n: {} };
      const iv = interval(it, now);
      const res = check({ s: iv.s, e: iv.e, add: kind === 'deliver' ? work : travel + stay }, [...all, ...created], now, st, null);
      initFlags(it, now);
      if (res.lvl !== 'ok') it.status = 'held';
      await putItem(it); created.push(it);
      blocks.push(promiseBlock(it, res, notes, now));
      if (it.status === 'held') rows.push([btn(`Add ${short(it.title)}`, `HY:${it.id}`), btn('Drop it', `HN:${it.id}`)]);
    } else {
      const est = p.estMin ?? def.est ?? 30;
      if (p.estMin == null) notes.push(`assumed ${fmtD(est)}`);
      let startAt = null;
      if (p.inMin != null) startAt = now + p.inMin * MIN;
      else if (p.time) { const r = resolveClock(p.time, now, p.dayOffset || 0); startAt = r.ms; if (r.assumed) notes.push(`read as ${fmtT(r.ms)}`); if (r.rolled) notes.push("that's tomorrow"); }
      else {
        const slot = findSlot([...all, ...created], est, now, st, null);
        if (slot) { startAt = slot.ms; notes.push(slot.off ? 'no room today, so tomorrow morning' : 'next free gap'); }
        else notes.push('no free gap found, so no time set');
      }
      const it = { id: newId(startAt ?? now), type: 'task', title: p.title, est, startAt, status: 'todo', created: now, moved: 0, n: {} };
      let warn = '';
      if (p.time || p.inMin != null) {
        const res = check({ s: startAt, e: startAt + est * MIN, add: est }, [...all, ...created], now, st, null);
        const bad = res.msgs.filter((m) => m[0] === 'bad' || m[0] === 'warn').map((m) => m[1]);
        if (bad.length) warn = `\n⚠️ ${esc(bad.join(' '))}`;
      }
      await putItem(it); created.push(it);
      blocks.push(`🗒 ${T(it)}\n${describe(it, now)}${noteText(notes)}${warn}`);
    }
  }
  if (created.length) {
    meta.recent = [...(meta.recent || []), ...created.map((c) => c.id)].slice(-6);
    meta.lastAdded = meta.recent[meta.recent.length - 1];
    await setMeta(meta);
  }
  const L = load([...all, ...created.filter((c) => c.status !== 'held')], now, st);
  const foot = created.length ? `\n\nDay load: ${fmtD(L.committed)} committed, ${fmtD(L.left)} left.` : '';
  return send(chat, heard + blocks.join('\n\n') + foot, rows);
}
async function forget(meta, id) {
  meta.recent = (meta.recent || []).filter((x) => x !== id);
  meta.lastAdded = meta.recent.length ? meta.recent[meta.recent.length - 1] : null;
  await setMeta(meta);
}
const short = (s) => (s.length > 14 ? s.slice(0, 13) + '…' : s);
const noteText = (notes) => (notes.length ? `\n<i>(${esc(notes.join('; '))})</i>` : '');
function promiseBlock(it, res, notes, now) {
  const head = describe(it, now);
  if (it.status === 'held') {
    const lines = res.msgs.filter((m) => m[0] !== 'info').map((m) => esc(m[1])).join('\n');
    return `⚠️ ${T(it)}\n${head}\n${lines}\n<b>Think twice before saying yes.</b> Add it anyway?${noteText(notes)}`;
  }
  const info = res.msgs.find((m) => m[0] === 'info');
  return `✅ ${T(it)}\n${head}\nClear.${info ? ' ' + esc(info[1]) : ''}${noteText(notes)}`;
}

/** Which item does "it's 20 min away" mean? The latest promise. Other edits mean the latest thing added. */
async function pickRecent(meta, patch) {
  const wantPromise = patch.travelMin != null || patch.stayMin != null || patch.workMin != null;
  for (const id of [...(meta.recent || [])].reverse()) {
    const it = await getItem(id);
    if (it && (!wantPromise || it.type === 'promise')) return it;
  }
  return meta.lastAdded ? getItem(meta.lastAdded) : null;
}
async function updateLast(chat, patch, now, meta) {
  const it = await pickRecent(meta, patch);
  if (!it) return send(chat, 'Nothing to change yet. Tell me what you are planning first.');
  const changed = [];
  if (patch.title) { it.title = patch.title; changed.push('title'); }
  if (it.type === 'promise') {
    if (patch.travelMin != null) { it.travel = patch.travelMin; changed.push('travel'); }
    else if (patch.estMin != null && it.kind === 'place') { it.travel = patch.estMin; changed.push('travel'); }
    if (patch.stayMin != null) { it.stay = patch.stayMin; changed.push('stay'); }
    if (patch.workMin != null || (patch.estMin != null && it.kind === 'deliver')) { it.work = patch.workMin ?? patch.estMin; changed.push('work'); }
    if (patch.time) { it.dueAt = resolveClock(patch.time, now, 0).ms; changed.push('time'); }
    it.n = {}; initFlags(it, now);
  } else {
    if (patch.estMin != null) { it.est = patch.estMin; changed.push('estimate'); }
    if (patch.time) { it.startAt = resolveClock(patch.time, now, 0).ms; changed.push('time'); }
  }
  if (!changed.length) return send(chat, "I couldn't tell what to change. Try “it's 15 min away” or “make that 4pm”.");
  await putItem(it);
  let extra = '';
  if (isOpen(it)) {
    const all = await loadAround(now, 0, 2);
    const iv = interval(it, now);
    const res = check({ s: iv.s, e: iv.e, add: it.type === 'task' ? it.est : (it.kind === 'deliver' ? it.work : it.travel + it.stay) }, all, now, meta.settings, it.id);
    const bad = res.msgs.filter((m) => m[0] !== 'info').map((m) => esc(m[1])).join('\n');
    extra = bad ? `\n⚠️ ${bad}` : '\nStill clear.';
  }
  return send(chat, `Updated ${changed.join(', ')}.\n${T(it)}\n${describe(it, now)}${extra}`);
}

async function cancelFlow(chat, target, now, meta) {
  const all = await loadAround(now, 0, 2);
  const pool = all.filter((i) => isOpen(i) || i.status === 'held');
  let pick = null;
  if (target && target.trim()) {
    const tk = tokens(target); let best = 0;
    for (const it of pool) { const s = tokens(it.title).filter((t) => tk.includes(t)).length; if (s > best) { best = s; pick = it; } }
  } else if (meta.lastAdded) pick = pool.find((i) => i.id === meta.lastAdded) || null;
  if (!pick) return send(chat, "I couldn't find that. Say /today to see what's open.");
  if (pick.type === 'promise' && pick.status === 'pending') { pick.status = 'cancelled'; pick.resolvedAt = now; await putItem(pick); }
  else await delItem(pick);
  await forget(meta, pick.id);
  return send(chat, `Cancelled ${T(pick)}.`);
}

/* ---------- views ---------- */
const ICON = { pending: '📍', ontime: '✅', late: '🟡', missed: '❌', cancelled: '⚪', unknown: '❔', held: '⏸', todo: '⬜', doing: '▶️', done: '✅', skipped: '⏭', carried: '↪️' };
export async function renderToday(now, st) {
  const all = await loadAround(now, 0, 0);
  const rows = all.filter((i) => i.status !== 'held' && i.status !== 'carried').map((i) => ({ i, iv: interval(i, now) }))
    .sort((a, b) => (a.iv ? a.iv.s : Infinity) - (b.iv ? b.iv.s : Infinity));
  if (!rows.length) return `<b>${fmtDate(now)}</b>\nNothing planned yet. Tell me what's on today.`;
  const lines = rows.map(({ i, iv }) => {
    const when = iv ? (i.type === 'promise' ? fmtT(i.dueAt) : fmtT(iv.s)) : 'any time';
    const extra = i.type === 'promise' && i.travel > 0 && i.status === 'pending' ? ` (leave ${fmtT(i.dueAt - i.travel * MIN)})` : '';
    return `${ICON[i.status] || '•'} ${when} ${T(i)}${extra}`;
  });
  const L = load(all, now, st);
  return `<b>${fmtDate(now)}</b>\n${lines.join('\n')}\n\nDay load: ${fmtD(L.committed)} committed, ${fmtD(L.left)} left (${fmtMin(st.winStart)}–${fmtMin(st.winEnd)}).`;
}

export async function renderReview(now) {
  const all = await loadAround(now, 14, 0);
  const week = all.filter((i) => (i.dueAt ?? i.startAt ?? i.created) >= now - 7 * 86400000);
  const s = stats(week);
  const out = ['<b>Last 7 days</b>'];
  out.push(s.resolved ? `Promises kept: ${s.kept} of ${s.resolved} (${Math.round((s.kept / s.resolved) * 100)}%)` : 'No promises checked in yet.');
  if (s.late) out.push(`When late, about ${Math.round(s.lateMin / s.late)} min late on average.`);
  if (s.unknown) out.push(`${s.unknown} never got an answer. Unanswered check-ins hide the real pattern.`);
  out.push(`Tasks done: ${s.done} of ${s.tasks}`);
  if (s.measured >= 3) {
    const r = s.act / s.est;
    out.push(r > 1.1 ? `Tasks take about ${r.toFixed(1)}× your estimates (${s.measured} timed). A 30 minute guess is closer to ${fmtD(Math.round((30 * r) / 5) * 5)}.` : r < 0.9 ? `You finish faster than you guess: ${r.toFixed(1)}× (${s.measured} timed).` : `Your estimates are close to reality (${s.measured} timed).`);
  } else out.push('Use Start and Done on 3 tasks and I will measure your estimates.');
  const rs = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (rs.length) out.push('Why things slip: ' + rs.map(([r, n]) => `${esc(r)} (${n})`).join(', '));
  const k = streak(all);
  if (k) out.push(`Streak: ${k} promise${k > 1 ? 's' : ''} kept in a row.`);
  return out.join('\n');
}

/* ---------- button taps ---------- */
async function handleCallback(cb, now) {
  const chat = cb.message?.chat?.id, mid = cb.message?.message_id;
  const meta = await getMeta();
  const owner = process.env.OWNER_CHAT_ID || meta.owner;
  if (!chat || String(chat) !== String(owner)) return answer(cb.id);
  const [act, id, arg] = String(cb.data || '').split(':');
  const it = id ? await getItem(id) : null;
  if (!it) { await answer(cb.id, 'That item is gone.'); return edit(chat, mid, 'That item no longer exists.'); }
  const n = (it.n = it.n || {});
  const done = async (text, rows, toast) => { await putItem(it); await answer(cb.id, toast); return edit(chat, mid, text, rows); };

  switch (act) {
    case 'L': it.leftAt = now; return done(`🚶 Left at ${fmtT(now)} for ${T(it)}. Safe trip.`);
    case 'K': {
      it.status = 'ontime'; it.resolvedAt = now; await putItem(it);
      const k = streak(await loadAround(now, 14, 0));
      return done(`✅ ${T(it)}: kept.${k > 1 ? ` ${k} in a row.` : ''}`, null, 'Kept');
    }
    case 'Lt': return answer(cb.id).then(() => edit(chat, mid, `How late were you for ${T(it)}?`, [[5, 10, 15, 30, 45, 60].map((m) => btn(`${m}m`, `LS:${it.id}:${m}`))]));
    case 'LS': it.status = 'late'; it.lateBy = Number(arg) || 10; it.resolvedAt = now; return done(`🟡 ${T(it)}: late by ${it.lateBy}m.\nWhat got in the way?`, whyRows(it.id));
    case 'M': it.status = 'missed'; it.resolvedAt = now; return done(`❌ ${T(it)}: missed.\nWhat got in the way?`, whyRows(it.id));
    case 'C': it.status = 'cancelled'; it.resolvedAt = now; return done(`⚪ ${T(it)}: cancelled. No penalty.`);
    case 'W': {
      const r = REASONS[Number(arg)];
      if (r) it.why = r;
      const label = it.type === 'promise' ? (it.status === 'late' ? `late by ${it.lateBy}m` : it.status) : it.status;
      return done(`${ICON[it.status] || '•'} ${T(it)}: ${label}${r ? ` · ${esc(r)}` : ''}.`, null, r ? 'Noted' : 'Skipped');
    }
    case 'HY': it.status = it.type === 'promise' ? 'pending' : 'todo'; n.held = null; return done(`✅ Added ${T(it)}, ${describe(it, now)}.`);
    case 'HN': await delItem(it); await forget(meta, it.id); await answer(cb.id, 'Dropped'); return edit(chat, mid, `Dropped ${T(it)}.`);
    case 'TS': it.status = 'doing'; it.startedAt = now; n.over = null; n.snooze = 0; if (!it.startAt) it.startAt = now; return done(`▶️ Started ${T(it)}. I'll check in after ${fmtD(it.est)}.`);
    case 'TL': it.startAt = (it.startAt || now) + 30 * MIN; it.moved = (it.moved || 0) + 1; n.start = null; return done(`⏭ ${T(it)} moved to ${fmtT(it.startAt)}.`);
    case 'TK': it.status = 'skipped'; it.resolvedAt = now; return done(`⏭ ${T(it)} skipped.\nWhat got in the way?`, whyRows(it.id));
    case 'TD': {
      if (!it.startedAt) {
        const vals = [...new Set([it.est, 15, 30, 45, 60, 90, 120])].sort((a, b) => a - b);
        await answer(cb.id);
        return edit(chat, mid, `How long did ${T(it)} take? (you guessed ${fmtD(it.est)})`, [vals.map((m) => btn(fmtD(m), `TA:${it.id}:${m}`))]);
      }
      return finishTask(it, Math.max(1, Math.round((now - it.startedAt) / MIN)), now, done);
    }
    case 'TA': return finishTask(it, Number(arg) || it.est, now, done);
    case 'TM': n.over = null; n.snooze = now + 15 * MIN; return done(`⏳ Okay, ${T(it)} gets 15 more minutes.`);
    default: return answer(cb.id);
  }
}
function finishTask(it, actual, now, done) {
  it.status = 'done'; it.actual = actual; it.resolvedAt = now;
  const r = actual / it.est;
  const verdict = r > 1.25 ? `${fmtD(actual - it.est)} over your ${fmtD(it.est)} guess.` : r < 0.8 ? `Faster than your ${fmtD(it.est)} guess.` : `Right on your ${fmtD(it.est)} guess.`;
  return done(`✅ ${T(it)} done in ${fmtD(actual)}. ${verdict}`, null, 'Done');
}
