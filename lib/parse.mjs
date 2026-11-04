// Turns a sentence into structured fields. Groq (free) first, a built-in parser if it fails.
import { parts, DAY } from './time.mjs';

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const INTENTS = ['add', 'update_last', 'cancel', 'show_today', 'review', 'help', 'chat'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const num = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

function systemPrompt(now) {
  const p = parts(now);
  return `You convert one short message from the user into JSON for a personal scheduling bot. Reply with JSON only.
It is ${DOW[p.dow]}, ${p.d}/${p.mo}/${p.y}, ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')} local time.

Schema:
{"intent":"add"|"update_last"|"cancel"|"show_today"|"review"|"help"|"chat",
 "items":[{"type":"promise"|"task","kind":"place"|"deliver","title":string,
   "time":{"h":number,"m":number,"mer":"am"|"pm"|null}|null,"inMin":number|null,"dayOffset":0|1,
   "travelMin":number|null,"stayMin":number|null,"workMin":number|null,"estMin":number|null}],
 "patch":{"title":string|null,"time":{"h":number,"m":number,"mer":"am"|"pm"|null}|null,"travelMin":number|null,"stayMin":number|null,"workMin":number|null,"estMin":number|null},
 "target":string|null}

Rules:
- "promise" = the user told someone they will be somewhere or deliver something at a time. "task" = something the user wants to do for themselves; it may have no time.
- kind "place" = be somewhere or meet someone. kind "deliver" = send or submit something by a time.
- "20 min away" or "takes 20 minutes to reach" -> travelMin 20. "for an hour" at a place -> stayMin 60. A task's duration ("45 mins") -> estMin.
- Never guess a number the user did not say; use null.
- Copy the clock hour as spoken. Only set "mer" if the user said am or pm. Use 24-hour h (13-23) only if the user said 24-hour time.
- "in 20 minutes" -> inMin 20 and time null. "tomorrow" -> dayOffset 1.
- title: at most 6 words, no times or durations.
- Several things in one message -> several items.
- "make that 30", "change it to 4pm", "it is 15 min away" refer to the item just added -> intent "update_last" with patch.
- "cancel the coffee" -> intent "cancel", target "coffee".
- "what's today", "my plan" -> "show_today". "how am I doing", "stats" -> "review". Greetings or anything else -> "chat".`;
}

function sanitize(r) {
  if (!r || !INTENTS.includes(r.intent)) return null;
  const clock = (t) => {
    if (!t || t.h == null) return null;
    const h = num(t.h, 0, 23), m = num(t.m ?? 0, 0, 59);
    if (h == null || m == null) return null;
    return { h, m, mer: t.mer === 'am' || t.mer === 'pm' ? t.mer : null };
  };
  const out = { intent: r.intent, items: [], patch: {}, target: typeof r.target === 'string' ? r.target : null };
  for (const i of (Array.isArray(r.items) ? r.items : []).slice(0, 6)) {
    const title = cap(String(i.title || '').trim().slice(0, 80));
    if (!title) continue;
    out.items.push({
      type: i.type === 'promise' ? 'promise' : 'task',
      kind: i.kind === 'deliver' ? 'deliver' : 'place',
      title, time: clock(i.time), inMin: num(i.inMin, 1, 1440), dayOffset: i.dayOffset === 1 ? 1 : 0,
      travelMin: num(i.travelMin, 0, 300), stayMin: num(i.stayMin, 0, 600),
      workMin: num(i.workMin, 0, 600), estMin: num(i.estMin, 5, 720),
    });
  }
  const p = r.patch || {};
  out.patch = {
    title: p.title ? String(p.title).slice(0, 80) : null, time: clock(p.time),
    travelMin: num(p.travelMin, 0, 300), stayMin: num(p.stayMin, 0, 600),
    workMin: num(p.workMin, 0, 600), estMin: num(p.estMin, 5, 720),
  };
  if (out.intent === 'add' && !out.items.length) out.intent = 'chat';
  return out;
}

async function viaGroq(text, now) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        temperature: 0, response_format: { type: 'json_object' }, max_tokens: 700,
        messages: [{ role: 'system', content: systemPrompt(now) }, { role: 'user', content: text }],
      }),
    });
    if (!r.ok) throw new Error(`groq ${r.status}`);
    const j = await r.json();
    return sanitize(JSON.parse(j.choices[0].message.content));
  } finally { clearTimeout(t); }
}

/* ---------- built-in fallback: covers the common phrasings without any AI ---------- */
const TIME_RE = /\b(?:at|by|@)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])/i;
const TRAVEL_RES = [
  /(\d+)\s*(?:min|mins|minutes)\s*(?:away|drive|travel|commute|ride|walk)/i,
  /(?:takes?|travel(?:ling|ing)?)\s*(?:me\s*)?(?:about\s*)?(\d+)\s*(?:min|mins|minutes)/i,
];
const DUR_RE = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i;
const toMin = (v, u) => Math.round(/^h/i.test(u) ? Number(v) * 60 : Number(v));

export function fallback(text) {
  const raw = text.trim();
  const low = raw.toLowerCase();
  if (/^\/?(today|plan)\s*$|^(what('| i)?s|show)\b.*\b(today|plan|my day)\b/.test(low)) return { intent: 'show_today', items: [], patch: {} };
  if (/^\/?(review|stats)\s*$|^how am i doing/.test(low)) return { intent: 'review', items: [], patch: {} };
  if (/^\/?(help|hi|hello|hey)\s*[!.]?\s*$/.test(low)) return { intent: 'help', items: [], patch: {} };
  const cm = /^(?:cancel|drop|remove|delete)\s+(?:the\s+)?(.+)$/.exec(low);
  if (cm) return { intent: 'cancel', items: [], patch: {}, target: cm[1] };

  let rest = raw;
  let travelMin = null;
  for (const re of TRAVEL_RES) { const m = re.exec(rest); if (m) { travelMin = Number(m[1]); rest = rest.replace(m[0], ' '); break; } }
  const tm = TIME_RE.exec(rest);
  let time = null;
  if (tm) {
    const mer = tm[3] ? (/^a/i.test(tm[3]) ? 'am' : 'pm') : null;
    time = { h: Math.min(23, Number(tm[1])), m: Number(tm[2] || 0), mer };
    rest = rest.replace(tm[0], ' ');
  }
  const inm = /\bin\s+(\d+)\s*(min|mins|minutes|hours?|hrs?|h)\b/i.exec(rest);
  let inMin = null;
  if (!time && inm) { inMin = toMin(inm[1], inm[2]); rest = rest.replace(inm[0], ' '); }
  const dm = DUR_RE.exec(rest);
  let dur = null;
  if (dm) { dur = toMin(dm[1], dm[2]); rest = rest.replace(dm[0], ' '); }
  const dayOffset = /\btomorrow\b/i.test(rest) ? 1 : 0;

  // Patch like "make that 30" / "it's 15 min away" / "change it to 4pm"
  if (/^(make|change|set|update|actually)\b|^it('| i)?s\b/.test(low) && /\b(that|it)\b/.test(low) && (time || dur || travelMin != null)) {
    const patch = { title: null, time, travelMin, stayMin: null, workMin: null, estMin: null };
    if (!time && travelMin == null && dur != null) patch.estMin = dur;
    return { intent: 'update_last', items: [], patch };
  }
  const title = rest
    .replace(/\b(tomorrow|today|remind me to|i('| wi)ll|i have to|i need to|i promised|promised|please|for)\b/gi, ' ')
    .replace(/[,.;]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title) return { intent: 'chat', items: [], patch: {} };
  const deliver = /\b(deliver|send|submit|share|finish|ship|due)\b/i.test(raw);
  if (time || inMin != null) {
    return {
      intent: 'add', patch: {}, items: [{
        type: 'promise', kind: deliver ? 'deliver' : 'place', title: cap(title.slice(0, 80)), time, inMin, dayOffset,
        travelMin, stayMin: deliver ? null : dur, workMin: deliver ? dur : null, estMin: null,
      }],
    };
  }
  return {
    intent: 'add', patch: {}, items: [{
      type: 'task', kind: 'place', title: cap(title.slice(0, 80)), time: null, inMin: null, dayOffset,
      travelMin: null, stayMin: null, workMin: null, estMin: dur && dur >= 5 ? dur : null,
    }],
  };
}

export async function parseMessage(text, now = Date.now()) {
  if (process.env.GROQ_API_KEY) {
    try { const r = await viaGroq(text, now); if (r) return r; } catch (e) { console.error('groq parse failed:', e.message); }
  }
  return fallback(text);
}
export { DAY };
