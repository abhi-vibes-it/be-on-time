import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STORE = 'memory';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
delete process.env.GROQ_API_KEY; // exercise the built-in parser

const sent = [];
globalThis.fetch = async (url, opts) => {
  const method = String(url).split('/').pop();
  sent.push({ method, body: JSON.parse(opts.body) });
  return { ok: true, json: async () => ({ ok: true, result: {} }) };
};

const { handleUpdate } = await import('../lib/bot.mjs');
const { runTick } = await import('../lib/tick.mjs');
const { resolveClock, fmtT, MIN } = await import('../lib/time.mjs');
const { findSlot, check, DEFAULT_SETTINGS } = await import('../lib/logic.mjs');
const { loadAround, resetMemory } = await import('../lib/store.mjs');
const { fallback } = await import('../lib/parse.mjs');

const ist = (h, m, d = 5) => Date.UTC(2026, 10, d, h, m) - 330 * MIN; // 5 Nov 2026, India time
const CHAT = 111;
const say = (text, now) => handleUpdate({ message: { chat: { id: CHAT }, text } }, now);
const tap = (data, now) => handleUpdate({ callback_query: { id: 'cb', data, message: { chat: { id: CHAT }, message_id: 9 } } }, now);
const lastText = () => sent.filter((s) => s.method === 'sendMessage' || s.method === 'editMessageText').at(-1).body.text;
const texts = () => sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text);

test('spoken clock times resolve to the sensible daytime hour', () => {
  assert.equal(fmtT(resolveClock({ h: 1, m: 0, mer: null }, ist(1, 5)).ms), '1:00 pm'); // 1am now, "at 1" means 1pm
  assert.equal(fmtT(resolveClock({ h: 3, m: 0, mer: null }, ist(13, 0)).ms), '3:00 pm');
  assert.equal(fmtT(resolveClock({ h: 9, m: 0, mer: null }, ist(13, 0)).ms), '9:00 pm'); // next 9 is tonight
  const next = resolveClock({ h: 9, m: 0, mer: 'am' }, ist(13, 0)); // explicit am, already past today
  assert.equal(fmtT(next.ms), '9:00 am');
  assert.equal(next.rolled, true);
  assert.equal(fmtT(resolveClock({ h: 14, m: 30, mer: null }, ist(9, 0)).ms), '2:30 pm');
  assert.equal(fmtT(resolveClock({ h: 12, m: 0, mer: null }, ist(9, 0)).ms), '12:00 pm');
});

test('fallback parser understands the common sentences', () => {
  const a = fallback('coffee with a friend at 3, 20 min away');
  assert.equal(a.items[0].type, 'promise'); assert.equal(a.items[0].travelMin, 20);
  assert.deepEqual(a.items[0].time, { h: 3, m: 0, mer: null });
  const b = fallback('review the draft, 45 mins');
  assert.equal(b.items[0].type, 'task'); assert.equal(b.items[0].estMin, 45);
  assert.equal(fallback("it's 30 min away").intent, 'update_last');
  assert.equal(fallback('cancel the coffee').target, 'coffee');
});

test('findSlot skips busy gaps and rolls to tomorrow when the day is full', () => {
  const now = ist(13, 0);
  const busy = { id: 'x', type: 'promise', kind: 'place', status: 'pending', dueAt: ist(13, 0), travel: 0, stay: 60, title: 'busy' };
  const s = findSlot([busy], 45, now, DEFAULT_SETTINGS, null);
  assert.equal(fmtT(s.ms), '2:05 pm'); // after the 1h stay + 5 min buffer
  const early = { ...busy, dueAt: ist(14, 0) };
  assert.equal(fmtT(findSlot([early], 45, now, DEFAULT_SETTINGS, null).ms), '1:00 pm'); // fits before it
  const full = { ...busy, dueAt: ist(13, 0), stay: 600 };
  const t = findSlot([full], 45, now, DEFAULT_SETTINGS, null);
  assert.equal(t.off, 1);
});

test('a full day of conversation: add, clash, nudge, check in', async () => {
  resetMemory(); sent.length = 0;
  const n0 = ist(13, 0);
  await say('/start', n0);
  assert.match(lastText(), /yours alone/);

  await say('coffee with a friend at 3, 20 min away', n0);
  assert.match(lastText(), /Coffee with a friend/);
  assert.match(lastText(), /leave 2:40 pm/);
  assert.match(lastText(), /Clear/);

  await say('review the draft, 45 mins', n0);
  assert.match(lastText(), /1:00 pm · 45m/);
  assert.match(lastText(), /next free gap/);

  await say('meeting with Ravi at 3, 10 min away', n0);
  assert.match(lastText(), /Overlaps/);
  assert.match(lastText(), /Think twice/);
  const held = sent.at(-1).body.reply_markup.inline_keyboard[0];
  assert.match(held[0].callback_data, /^HY:/);
  assert.match(held[1].callback_data, /^HN:/);
  await tap(held[1].callback_data, n0); // drop it
  assert.match(lastText(), /Dropped/);

  await say("it's 30 min away", n0);
  assert.match(lastText(), /Updated travel/);

  // nudges: task start, leave warning, leave now, check-in
  sent.length = 0;
  await runTick(ist(13, 0));
  assert.ok(texts().some((t) => /Time to start/.test(t)), 'start nudge');
  await runTick(ist(13, 0)); // same minute again must not repeat
  assert.equal(texts().filter((t) => /Time to start/.test(t)).length, 1);

  sent.length = 0;
  await runTick(ist(14, 25)); // leave at 14:30 (30 min travel), pre-nudge at 14:25
  assert.ok(texts().some((t) => /Leave in 5 min/.test(t)), 'pre-leave nudge');
  await runTick(ist(14, 30));
  assert.ok(texts().some((t) => /Time to leave/.test(t)), 'leave now nudge');
  await runTick(ist(15, 0));
  const ask = sent.filter((s) => s.method === 'sendMessage').at(-1);
  assert.match(ask.body.text, /Did you make it/);
  const kept = ask.body.reply_markup.inline_keyboard[0][0].callback_data;

  await tap(kept, ist(15, 1));
  assert.match(lastText(), /kept/);
  const items = await loadAround(ist(15, 1), 0, 0);
  assert.equal(items.find((i) => i.type === 'promise').status, 'ontime');

  await say('/today', ist(15, 2));
  assert.match(lastText(), /Day load/);
  await say('review', ist(15, 2));
  assert.match(lastText(), /Promises kept: 1 of 1/);
});

test('late answers ask why and the reason is recorded', async () => {
  resetMemory(); sent.length = 0;
  const n0 = ist(10, 0);
  await say('/start', n0);
  await say('lunch with a friend at 1, 15 min away', n0);
  await runTick(ist(13, 0));
  const ask = sent.filter((s) => s.method === 'sendMessage').at(-1);
  const late = ask.body.reply_markup.inline_keyboard[0][1].callback_data;
  await tap(late, ist(13, 5));
  const mins = sent.at(-1).body.reply_markup.inline_keyboard[0][1].callback_data; // 10m
  await tap(mins, ist(13, 5));
  assert.match(lastText(), /late by 10m/);
  const why = sent.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
  await tap(why, ist(13, 5));
  assert.match(lastText(), /Previous thing ran long/);
});

test('strangers are ignored once an owner exists', async () => {
  resetMemory(); sent.length = 0;
  await say('/start', ist(9, 0));
  sent.length = 0;
  await handleUpdate({ message: { chat: { id: 999 }, text: 'lunch at 1' } }, ist(9, 1));
  assert.equal(sent.length, 0);
});

test('check flags tight gaps', () => {
  const now = ist(10, 0);
  const a = { id: 'a', type: 'task', title: 'Draft', status: 'todo', startAt: ist(11, 0), est: 60 };
  const r = check({ s: ist(12, 5), e: ist(12, 35), add: 30 }, [a], now, DEFAULT_SETTINGS, null);
  assert.equal(r.lvl, 'warn');
  assert.match(r.msgs[0][1], /5 min after/);
});

test('morning note carries over unfinished tasks once; evening wrap summarises', async () => {
  resetMemory(); sent.length = 0;
  await say('/start', ist(10, 0, 5));
  await say('write the report, 60 mins', ist(10, 0, 5)); // left undone on the 5th
  sent.length = 0;
  await runTick(ist(8, 30, 6)); // next morning, brief time is 8:30
  await runTick(ist(8, 31, 6)); // must not send a second note
  const notes = texts().filter((t) => /Good morning/.test(t));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Carried over 1 unfinished task/);
  assert.match(notes[0], /Write the report/);
  const today = await loadAround(ist(8, 31, 6), 1, 0);
  assert.equal(today.filter((i) => i.status === 'carried').length, 1);
  assert.equal(today.filter((i) => i.status === 'todo').length, 1);

  sent.length = 0;
  await runTick(ist(21, 0, 6));
  await runTick(ist(21, 1, 6));
  assert.equal(texts().filter((t) => /Day wrap/.test(t)).length, 1);
  assert.match(texts().find((t) => /Day wrap/.test(t)), /1 open task will roll into tomorrow/);
});
