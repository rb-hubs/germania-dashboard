// germania-turnierplan – zentraler Speicher für turniere.html
// Lesen ist offen (die Seite ist öffentlich), Schreiben braucht Passwort (Trainer) oder Token (AVA).
// Jede Änderung legt eine Sicherung an (90 Tage), siehe /turnierplan/sicherungen.

const KEY = 'plan';
const MAX_BYTES = 512 * 1024;
const BACKUP_TTL = 90 * 24 * 3600;

const isAllowed = o => o === 'https://rb-hubs.github.io' || /^http:\/\/localhost(:\d+)?$/.test(o);

function cors(request) {
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': isAllowed(origin) ? origin : 'https://rb-hubs.github.io',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

const json = (data, status, request) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(request) }
});

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthorized(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  return safeEqual(token, env.TURNIER_PASSWORT) || safeEqual(token, env.TURNIER_AGENT_TOKEN);
}

const validItem = t => t && typeof t === 'object' && !Array.isArray(t) && typeof t.id === 'string' && t.id.length > 0 && t.id.length <= 100;

async function store(env, plan, previous) {
  const next = { items: plan.items, rev: ((previous && previous.rev) || 0) + 1, geaendert: new Date().toISOString() };
  if (previous) await env.TURNIERPLAN.put(`sicherung:${previous.rev}`, JSON.stringify(previous), { expirationTtl: BACKUP_TTL });
  await env.TURNIERPLAN.put(KEY, JSON.stringify(next));
  return next;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
    const { pathname } = new URL(request.url);
    const current = () => env.TURNIERPLAN.get(KEY, 'json');

    if (request.method === 'GET' && pathname === '/turnierplan') {
      const plan = await current();
      return plan ? json(plan, 200, request) : json({ error: 'leer' }, 404, request);
    }

    if (request.method !== 'POST') return json({ error: 'not_found' }, 404, request);
    if (!isAuthorized(request, env)) return json({ error: 'passwort' }, 401, request);

    if (pathname === '/turnierplan/sicherungen') {
      const list = await env.TURNIERPLAN.list({ prefix: 'sicherung:' });
      return json({ sicherungen: list.keys.map(k => k.name) }, 200, request);
    }

    const raw = await request.text();
    if (raw.length > MAX_BYTES) return json({ error: 'zu_gross' }, 413, request);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'kein_json' }, 400, request); }

    // Ein Turnier speichern: andere Turniere bleiben unberührt, zwei Geräte überschreiben sich nicht gegenseitig.
    if (pathname === '/turnierplan/turnier') {
      if (!validItem(body.item)) return json({ error: 'turnier_ungueltig' }, 400, request);
      const plan = await current();
      if (!plan) return json({ error: 'leer' }, 409, request);
      const exists = plan.items.some(t => t.id === body.item.id);
      const items = exists ? plan.items.map(t => (t.id === body.item.id ? body.item : t)) : [...plan.items, body.item];
      return json(await store(env, { items }, plan), 200, request);
    }

    // Einmalige Befüllung; ein bestehender Plan wird nie überschrieben.
    if (pathname === '/turnierplan/start') {
      if (!Array.isArray(body.items) || !body.items.length || !body.items.every(validItem)) return json({ error: 'items_ungueltig' }, 400, request);
      const plan = await current();
      if (plan) return json({ error: 'schon_befuellt', rev: plan.rev }, 409, request);
      return json(await store(env, { items: body.items }, null), 200, request);
    }

    return json({ error: 'not_found' }, 404, request);
  }
};
