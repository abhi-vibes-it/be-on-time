// Runs every minute. Sends the nudges that make the screen-off experience work:
// leave-now alerts, start-now alerts, "did you make it?", plus the morning note and evening wrap.
import { MIN, parts, dayKey, addDays, newId, fmtT, fmtD } from './time.mjs';
import { isOpen, findSlot, stats, streak } from './logic.mjs';
import { getMeta, setMeta, putItem, delItem, loadAround } from './store.mjs';
import { send, btn, esc } from './tg.mjs';
import { renderToday } from './bot.mjs';

const T = (it) => `<b>${esc(it.title)}</b>`;
const FRESH = 20 * MIN; // never send a stale "leave in 5 min" more than 20 minutes late

export async function runTick(now = Date.now()) {
  const meta = await getMeta();
  const chat = process.env.OWNER_CHAT_ID || meta.owner;
  if (!chat) return { skipped: 'no owner yet' };
  const items = await loadAround(now, 1, 2);
  let sent = 0;

  for (const it of items) {
    if (it.status === 'held') { if (now - it.created > 3 * 60 * MIN) await delItem(it); continue; }
    const n = (it.n = it.n || {});
    let dirty = false;
    const mark = (k, v = now) => { n[k] = v; dirty = true; };
    const say = async (text, rows) => { await send(chat, text, rows); sent++; };

    if (it.type === 'promise' && it.status === 'pending') {
      const due = it.dueAt, leaveAt = due - (it.travel || 0) * MIN;
      if (it.kind === 'place') {
        if (it.travel > 0) {
          if (!n.pre && !it.leftAt && now >= leaveAt - 5 * MIN && now < leaveAt + FRESH) {
            if (now < leaveAt) await say(`⏰ Leave in ${Math.max(1, Math.round((leaveAt - now) / MIN))} min for ${T(it)}.\nBe there by ${fmtT(due)} (${fmtD(it.travel)} travel).`, [[btn("I've left", `L:${it.id}`)]]);
            mark('pre');
          }
          if (!n.leave && !it.leftAt && now >= leaveAt && now < leaveAt + FRESH) {
            await say(`🚪 Time to leave for ${T(it)} now.\nBe there by ${fmtT(due)}.`, [[btn("I've left", `L:${it.id}`)]]);
            mark('leave');
          }
        } else if (!n.pre && now >= due - 10 * MIN && now < due) {
          await say(`📍 ${T(it)} at ${fmtT(due)}, in ${Math.max(1, Math.round((due - now) / MIN))} min.`); mark('pre');
        }
      } else if (it.work > 0 && !n.pre && now >= due - it.work * MIN && now < due) {
        await say(`📤 Start on ${T(it)} now. It's due ${fmtT(due)} and needs ${fmtD(it.work)}.`); mark('pre');
      }
      if (now >= due) {
        const deliver = it.kind === 'deliver';
        const rows = [[btn(deliver ? 'On time ✅' : 'Made it ✅', `K:${it.id}`), btn('Late', `Lt:${it.id}`)], [btn(deliver ? 'Not delivered' : 'Missed', `M:${it.id}`), btn('Cancelled', `C:${it.id}`)]];
        if (!n.ask) { await say(deliver ? `Did you deliver ${T(it)}?` : `Did you make it to ${T(it)}?`, rows); mark('ask'); }
        else if (!n.ask2 && now >= n.ask + 45 * MIN) { await say(`Still need an answer: ${deliver ? 'did you deliver' : 'did you make it to'} ${T(it)}?`, rows); mark('ask2'); }
        else if (n.ask2 && now >= n.ask2 + 3 * 60 * MIN) { it.status = 'unknown'; dirty = true; }
      }
    }

    if (it.type === 'task') {
      if (it.status === 'todo' && it.startAt && !n.start && now >= it.startAt && now < it.startAt + 90 * MIN && now >= (n.snooze || 0)) {
        await say(`▶️ Time to start ${T(it)} (${fmtD(it.est)}).`, [[btn('Start', `TS:${it.id}`), btn('Later +30m', `TL:${it.id}`), btn('Skip', `TK:${it.id}`)]]);
        mark('start');
      }
      if (it.status === 'doing' && !n.over && now >= it.startedAt + it.est * MIN && now >= (n.snooze || 0)) {
        await say(`⏱ ${T(it)} has used its ${fmtD(it.est)}. Done?`, [[btn('Done', `TD:${it.id}`), btn('15 more min', `TM:${it.id}`), btn('Skip', `TK:${it.id}`)]]);
        mark('over');
      }
    }
    if (dirty) await putItem(it);
  }

  /* morning note and evening wrap, each once a day */
  const st = meta.settings, key = dayKey(now), p = parts(now);
  let metaDirty = false;
  if (p.min >= st.briefMin && p.min < st.briefMin + 240 && meta.lastBrief !== key) {
    meta.lastBrief = key; metaDirty = true;
    await setMeta(meta); // claim first so an overlapping run cannot send it twice
    await morning(chat, now, st, items);
    sent++;
  }
  if (p.min >= st.eveMin && p.min < st.eveMin + 240 && meta.lastEve !== key) {
    meta.lastEve = key; metaDirty = true;
    await setMeta(meta);
    await evening(chat, now, st);
    sent++;
  }
  if (metaDirty) await setMeta(meta);
  return { sent };
}

async function morning(chat, now, st, items) {
  const today = dayKey(now), yest = addDays(today, -1);
  let carried = 0;
  const live = items.filter((i) => i.status !== 'carried');
  for (const old of items.filter((i) => i.type === 'task' && dayKey(i.startAt ?? i.created) === yest && (i.status === 'todo' || i.status === 'doing'))) {
    const slot = findSlot(live, old.est, now, st, null);
    const startAt = slot ? slot.ms : null;
    const copy = { id: newId(startAt ?? now), type: 'task', title: old.title, est: old.est, startAt, status: 'todo', created: now, moved: (old.moved || 0) + 1, n: {} };
    old.status = 'carried'; await putItem(old);
    await putItem(copy); live.push(copy); carried++;
  }
  const body = await renderToday(now, st);
  const note = carried ? `\n↪️ Carried over ${carried} unfinished task${carried > 1 ? 's' : ''} from yesterday.` : '';
  const k = streak(await loadAround(now, 14, 0));
  await send(chat, `☀️ <b>Good morning.</b>\n\n${body}${note}${k >= 3 ? `\n🔥 ${k} promises kept in a row. Keep it going.` : ''}\n\nWhat else is on today? Tell me in a sentence.`);
}

async function evening(chat, now, st) {
  const all = await loadAround(now, 14, 0);
  const key = dayKey(now);
  const today = all.filter((i) => dayKey(i.dueAt ?? i.startAt ?? i.created) === key && i.status !== 'held');
  const s = stats(today);
  const lines = ['🌙 <b>Day wrap</b>'];
  lines.push(s.resolved ? `Promises kept: ${s.kept} of ${s.resolved}.` : 'No promises checked in today.');
  lines.push(`Tasks done: ${s.done} of ${s.tasks}.`);
  if (s.measured) { const r = s.act / s.est; lines.push(r > 1.1 ? `Your tasks ran ${r.toFixed(1)}× your estimates today. Pad tomorrow's guesses.` : `Estimates were close today (${r.toFixed(1)}×).`); }
  const k = streak(all);
  if (k) lines.push(`🔥 Streak: ${k} kept in a row.`);
  const pend = today.filter((i) => i.type === 'promise' && i.status === 'pending');
  if (pend.length) lines.push(`Still waiting on your answer: ${pend.map((i) => esc(i.title)).join(', ')}.`);
  const open = today.filter((i) => i.type === 'task' && isOpen(i)).length;
  if (open) lines.push(`${open} open task${open > 1 ? 's' : ''} will roll into tomorrow morning.`);
  await send(chat, lines.join('\n'));
}
