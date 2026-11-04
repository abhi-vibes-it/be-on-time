// Storage. Netlify Blobs in production; an in-memory Map when STORE=memory (tests).
// Each item is its own key (i/<YYYYMMDD>/<id>) so the scheduler and the webhook rarely overwrite each other.
import { MIN, dayKey, addDays, keyFromId } from './time.mjs';
import { DEFAULT_SETTINGS } from './logic.mjs';

let mem = null;
let nb = null;
async function backend() {
  if (process.env.STORE === 'memory') {
    mem = mem || new Map();
    return {
      get: async (k) => (mem.has(k) ? structuredClone(mem.get(k)) : null),
      set: async (k, v) => { mem.set(k, structuredClone(v)); },
      del: async (k) => { mem.delete(k); },
      list: async (p) => [...mem.keys()].filter((k) => k.startsWith(p)),
    };
  }
  if (!nb) {
    const { getStore } = await import('@netlify/blobs');
    const s = getStore({ name: 'abhi-on-time', consistency: 'strong' });
    nb = {
      get: (k) => s.get(k, { type: 'json' }),
      set: (k, v) => s.setJSON(k, v),
      del: (k) => s.delete(k),
      list: async (p) => { const { blobs } = await s.list({ prefix: p }); return blobs.map((b) => b.key); },
    };
  }
  return nb;
}
export function resetMemory() { mem = new Map(); }

const itemKey = (id) => `i/${keyFromId(id)}/${id}`;

export async function getMeta() {
  const b = await backend();
  const m = (await b.get('meta')) || {};
  return { owner: null, lastBrief: '', lastEve: '', lastAdded: null, ...m, settings: { ...DEFAULT_SETTINGS, ...(m.settings || {}) } };
}
export async function setMeta(m) { return (await backend()).set('meta', m); }
export async function getItem(id) { return (await backend()).get(itemKey(id)); }
export async function putItem(it) { return (await backend()).set(itemKey(it.id), it); }
export async function delItem(it) { return (await backend()).del(itemKey(it.id)); }

export async function listDay(key) {
  const b = await backend();
  const keys = await b.list(`i/${key}/`);
  const items = await Promise.all(keys.map((k) => b.get(k)));
  return items.filter(Boolean);
}
/** All items from `back` days ago to `fwd` days ahead of `now`. */
export async function loadAround(now, back = 1, fwd = 2) {
  const today = dayKey(now);
  const keys = [];
  for (let i = -back; i <= fwd; i++) keys.push(addDays(today, i));
  return (await Promise.all(keys.map(listDay))).flat();
}
export { MIN };
