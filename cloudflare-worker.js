/**
 * Germania Bambini – Notion Sync Worker
 * Cloudflare Worker als CORS-Proxy für Notion API
 *
 * Ermöglicht Live-Edit im Trainingsplan (GitHub Pages) → Notion Update
 *
 * Environment Variables (Secrets):
 *   NOTION_TOKEN  – Notion Internal Integration Token
 *   SYNC_SECRET   – Shared Secret für Auth (verhindert Missbrauch)
 *
 * Deploy: wrangler deploy
 */

const ALLOWED_ORIGINS = [
  'https://rb-hubs.github.io',
  'http://localhost',
  'null' // für lokale file:// Zugriffe
];

export default {
  async fetch(request, env) {
    // CORS Preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(request);
    }

    const url = new URL(request.url);

    // GET-Routes (read-only, public)
    if (request.method === 'GET') {
      if (url.pathname === '/trainings') return handleGetTrainings(request, env);
      if (url.pathname === '/turniere') return handleGetTurniere(request, env);
      if (url.pathname === '/kader') return handleGetKader(request, env);
      if (url.pathname === '/uebungen') return handleGetUebungen(request, env);
      if (url.pathname === '/dashboard-data') return handleGetDashboardData(request, env);
      if (url.pathname === '/health') return jsonResponse({ status: 'ok', service: 'germania-notion-sync' }, 200, request);
      return jsonResponse({ error: 'Not found' }, 404, request);
    }

    // POST-Routes (write, sync-secret-protected)
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, request);
    }

    // Routes
    if (url.pathname === '/sync-teams') {
      return handleSyncTeams(request, env);
    }

    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', service: 'germania-notion-sync' }, 200, request);
    }

    return jsonResponse({ error: 'Not found' }, 404, request);
  }
};

/**
 * POST /sync-teams
 *
 * Body:
 * {
 *   "secret": "...",
 *   "pageId": "uuid des Trainingshistorie-Eintrags",
 *   "teams": {
 *     "Blau": ["Name1", "Name2", ...],
 *     "Rot": [...],
 *     ...
 *   },
 *   "abwesend": {
 *     "rechtzeitig": ["Name1"],
 *     "kurzfristig": [],
 *     "unentschuldigt": []
 *   },
 *   "anzahlKinder": 17
 * }
 */
async function handleSyncTeams(request, env) {
  try {
    const body = await request.json();

    // Auth prüfen
    if (body.secret !== env.SYNC_SECRET) {
      return jsonResponse({ error: 'Unauthorized' }, 401, request);
    }

    const { pageId, teams, abwesend, anzahlKinder } = body;

    if (!pageId) {
      return jsonResponse({ error: 'pageId required' }, 400, request);
    }

    // 1. Properties updaten (Abwesend + Anwesende Kinder)
    const abwesendText = formatAbwesend(abwesend);

    const propsPayload = {
      properties: {}
    };

    if (abwesendText !== undefined) {
      propsPayload.properties['Abwesend'] = {
        rich_text: [{
          type: 'text',
          text: { content: abwesendText }
        }]
      };
    }

    if (anzahlKinder !== undefined) {
      propsPayload.properties['Anwesende Kinder'] = {
        number: anzahlKinder
      };
    }

    // Notion API: Properties updaten
    const propsResponse = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify(propsPayload)
    });

    if (!propsResponse.ok) {
      const err = await propsResponse.text();
      return jsonResponse({
        error: 'Notion API error (properties)',
        status: propsResponse.status,
        details: err
      }, 502, request);
    }

    // 2. Page Content updaten (Teams-Abschnitt)
    let contentUpdated = false;
    if (teams) {
      contentUpdated = await updateTeamsContent(pageId, teams, env);
    }

    return jsonResponse({
      success: true,
      updated: {
        properties: true,
        content: contentUpdated,
        abwesend: abwesendText,
        anzahlKinder: anzahlKinder
      }
    }, 200, request);

  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

/**
 * Formatiert die 3-stufige Abwesenheit als Text für Notion
 */
function formatAbwesend(abwesend) {
  if (!abwesend) return undefined;

  const parts = [];

  if (abwesend.rechtzeitig?.length) {
    parts.push(`✓ ${abwesend.rechtzeitig.join(', ')}`);
  }
  if (abwesend.kurzfristig?.length) {
    parts.push(`⚠️ ${abwesend.kurzfristig.join(', ')}`);
  }
  if (abwesend.unentschuldigt?.length) {
    parts.push(`🚫 ${abwesend.unentschuldigt.join(', ')}`);
  }

  return parts.join('\n') || '–';
}

/**
 * Reverse zu formatAbwesend(): zerlegt den Notion-Text wieder in
 * { rechtzeitig, kurzfristig, unentschuldigt }.
 *
 * Erkennt Zeilen-Präfixe ✓ / ⚠️ / 🚫 (auch ⚠ ohne VS16). Splittet die
 * Namen anschließend an Komma. Zeilen ohne erkanntes Präfix landen in
 * `rechtzeitig` (graceful fallback). "–" oder leer ⇒ alle Listen leer.
 */
function parseAbwesend(text) {
  const empty = { rechtzeitig: [], kurzfristig: [], unentschuldigt: [] };
  if (!text || typeof text !== 'string') return empty;
  const trimmed = text.trim();
  if (!trimmed || trimmed === '–' || trimmed === '-') return empty;

  const result = { rechtzeitig: [], kurzfristig: [], unentschuldigt: [] };
  // Zeilen via Newline ODER Bullet trennen (Notion liefert manchmal alles in einer Zeile)
  const lines = trimmed.split(/\n|(?=✓|⚠|🚫)/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    let bucket = 'rechtzeitig';
    let rest = line;
    if (line.startsWith('✓')) { bucket = 'rechtzeitig'; rest = line.slice(1); }
    else if (line.startsWith('⚠️')) { bucket = 'kurzfristig'; rest = line.slice(2); }
    else if (line.startsWith('⚠')) { bucket = 'kurzfristig'; rest = line.slice(1); }
    else if (line.startsWith('🚫')) { bucket = 'unentschuldigt'; rest = line.slice(2); }

    const names = rest.split(',').map(s => s.trim()).filter(Boolean);
    result[bucket].push(...names);
  }

  return result;
}

/**
 * Aktualisiert den Teams-Abschnitt im Seiteninhalt
 * Sucht nach dem "## Teams" Block und ersetzt ihn
 */
async function updateTeamsContent(pageId, teams, env) {
  try {
    // Kinder-Blocks der Seite laden
    const blocksResp = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
      headers: {
        'Authorization': `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28'
      }
    });

    if (!blocksResp.ok) return false;

    const blocksData = await blocksResp.json();
    const blocks = blocksData.results;

    // "Teams" Heading finden
    let teamsHeadingIdx = -1;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === 'heading_2' && b.heading_2?.rich_text?.[0]?.plain_text?.includes('Teams')) {
        teamsHeadingIdx = i;
        break;
      }
    }

    if (teamsHeadingIdx === -1) return false;

    // Alte Team-Bullets löschen (alles zwischen "Teams" heading und nächstem heading)
    const toDelete = [];
    for (let i = teamsHeadingIdx + 1; i < blocks.length; i++) {
      if (blocks[i].type.startsWith('heading_')) break;
      toDelete.push(blocks[i].id);
    }

    for (const blockId of toDelete) {
      await fetch(`https://api.notion.com/v1/blocks/${blockId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28'
        }
      });
    }

    // Neue Team-Bullets einfügen
    const newBlocks = [];
    for (const [teamName, players] of Object.entries(teams)) {
      newBlocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            { type: 'text', text: { content: `${teamName}: ` }, annotations: { bold: true } },
            { type: 'text', text: { content: players.join(', ') } }
          ]
        }
      });
    }

    if (newBlocks.length > 0) {
      await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${env.NOTION_TOKEN}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28'
        },
        body: JSON.stringify({
          children: newBlocks,
          after: blocks[teamsHeadingIdx].id
        })
      });
    }

    return true;
  } catch (e) {
    console.error('Content update failed:', e);
    return false;
  }
}


// === GET Handlers ===

const DS_TRAININGS = 'cc1275ee-918e-4fa2-a973-4dd4bb4e78e7';
const DS_KADER = '99ed9b49-bdff-4057-9198-a5025690448c';
const DS_UEBUNGEN = '5514b6fe-6e0f-43b0-8473-bfce09ce3471';
const DS_TURNIERE = 'c2a3892f-c4f8-434c-b3a0-00b8e930cc0c';

async function notionQuery(dataSourceId, env, body = {}) {
  const resp = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2025-09-03'
    },
    body: JSON.stringify({ page_size: 100, ...body })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Notion query failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

function pickPlain(prop, type = 'rich_text') {
  if (!prop) return '';
  const arr = prop[type] || prop.title || [];
  return Array.isArray(arr) ? arr.map(x => x.plain_text || '').join('') : '';
}

function pickSelect(prop) { return prop?.select?.name || ''; }
function pickMulti(prop) { return prop?.multi_select?.map(s => s.name) || []; }
function pickNumber(prop) { return prop?.number ?? null; }
function pickDate(prop) { return prop?.date?.start || ''; }
function pickRelations(prop) { return prop?.relation?.map(r => r.id) || []; }

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

async function handleGetTrainings(request, env) {
  try {
    // Trainings + Kader + Übungen parallel laden – Wahrheit für Anwesenheit
    // liegt in der Spieler-DB (Property "Trainings"). Übungen via ID→Name-Map.
    const [tData, kData, uData] = await Promise.all([
      notionQuery(DS_TRAININGS, env, { sorts: [{ property: 'Datum', direction: 'ascending' }] }),
      notionQuery(DS_KADER, env),
      notionQuery(DS_UEBUNGEN, env)
    ]);

    // Map: notionId → Spielername UND Map: trainingId → [spielerNamen]
    const idToName = new Map();
    const trainingToAnwesend = new Map();
    for (const p of kData.results) {
      const name = pickPlain(p.properties?.['Name'], 'title');
      if (!name) continue;
      idToName.set(p.id, name);
      const trainingsRel = p.properties?.['Trainings']?.relation || [];
      for (const ref of trainingsRel) {
        if (!trainingToAnwesend.has(ref.id)) trainingToAnwesend.set(ref.id, []);
        trainingToAnwesend.get(ref.id).push(name);
      }
    }

    // Map: notionId → Übungs-Name
    const uebungIdToName = new Map();
    for (const u of uData.results) {
      const name = pickPlain(u.properties?.['Name'], 'title');
      if (name) uebungIdToName.set(u.id, name);
    }

    const trainings = tData.results.map((page, idx) => {
      const props = page.properties || {};
      const abwesendText = pickPlain(props['Abwesend']);
      const fromReverse = trainingToAnwesend.get(page.id) || [];
      const spielerIds = pickRelations(props['Spieler']);
      const fromForward = spielerIds.map(id => idToName.get(id)).filter(Boolean);
      const anwesend = fromReverse.length ? fromReverse : fromForward;
      const uebungenIds = pickRelations(props['Übungen']);
      const uebungen = uebungenIds.map(id => uebungIdToName.get(id)).filter(Boolean);
      return {
        id: idx + 1,
        notionId: page.id,
        name: pickPlain(props['Name'], 'title'),
        datum: formatDate(pickDate(props['Datum'])),
        anwesendeKinder: pickNumber(props['Anwesende Kinder']) || 0,
        anwesend,
        abwesend: parseAbwesend(abwesendText),
        abwesendText,
        trainer: pickMulti(props['Trainer']),
        kategorien: pickMulti(props['Kategorie']),
        coaching: pickPlain(props['Coaching-Schwerpunkte']),
        besonderheiten: pickPlain(props['Besonderheiten']),
        spielerIds,
        uebungen,
        uebungenIds
      };
    });
    return jsonResponse({ trainings }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

async function handleGetKader(request, env) {
  try {
    const data = await notionQuery(DS_KADER, env);
    const kader = data.results.map(page => {
      const props = page.properties || {};
      const staerke = pickSelect(props['Stärke']);
      let r = '🟡';
      if (staerke.includes('stark')) r = '🔵';
      else if (staerke.includes('Beginner')) r = '🟢';
      return {
        notionId: page.id,
        n: pickPlain(props['Name'], 'title'),
        r: r,
        team: pickSelect(props['Team']),
        notizen: pickPlain(props['Notizen']),
        mitgliedSeit: pickDate(props['MitgliedSeit']),
        trainingsCount: pickRelations(props['Trainings']).length,
        turniereCount: pickRelations(props['Turniere']).length
      };
    }).filter(k => k.n).sort((a, b) => a.n.localeCompare(b.n));
    return jsonResponse({ kader }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

async function handleGetTurniere(request, env) {
  try {
    // Turniere + Kader parallel: Anwesenheit-Wahrheit liegt in Spieler.Turniere-Relation,
    // zusätzlich Abgesagt-Liste aus Turniere.Abgesagt (Komma-Liste von Namen).
    const [tData, kData] = await Promise.all([
      notionQuery(DS_TURNIERE, env, { sorts: [{ property: 'Datum', direction: 'ascending' }] }),
      notionQuery(DS_KADER, env)
    ]);

    const idToName = new Map();
    const turnierToDa = new Map();
    for (const p of kData.results) {
      const name = pickPlain(p.properties?.['Name'], 'title');
      if (!name) continue;
      idToName.set(p.id, name);
      const turniereRel = p.properties?.['Turniere']?.relation || [];
      for (const ref of turniereRel) {
        if (!turnierToDa.has(ref.id)) turnierToDa.set(ref.id, []);
        turnierToDa.get(ref.id).push(name);
      }
    }

    const turniere = tData.results.map((page, idx) => {
      const props = page.properties || {};
      const spielerIds = pickRelations(props['Spieler']);
      // "Da" = Spieler-Relation (forward) ODER reverse aus Spieler.Turniere
      const fromForward = spielerIds.map(id => idToName.get(id)).filter(Boolean);
      const fromReverse = turnierToDa.get(page.id) || [];
      const da = fromReverse.length ? fromReverse : fromForward;
      const abgesagtText = pickPlain(props['Abgesagt']);
      const abgesagt = parseNamesList(abgesagtText);
      return {
        id: idx + 1,
        notionId: page.id,
        name: pickPlain(props['Name'], 'title'),
        datum: formatDate(pickDate(props['Datum'])),
        datumIso: pickDate(props['Datum']),
        ort: pickPlain(props['Ort']),
        format: pickSelect(props['Format']),
        platzierung: pickPlain(props['Platzierung']),
        ergebnis: pickPlain(props['Ergebnis']),
        highlights: pickPlain(props['Highlights']),
        notizen: pickPlain(props['Notizen']),
        da,
        abgesagt,
        abgesagtText,
        spielerIds
      };
    });
    return jsonResponse({ turniere }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

/**
 * Zerlegt eine Komma-/Newline-getrennte Namensliste in ein Array.
 * Akzeptiert "Name1, Name2" oder "Name1\nName2".
 */
function parseNamesList(text) {
  if (!text || typeof text !== 'string') return [];
  return text.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
}

async function handleGetUebungen(request, env) {
  try {
    const data = await notionQuery(DS_UEBUNGEN, env);
    const uebungen = data.results.map(page => {
      const props = page.properties || {};
      return {
        notionId: page.id,
        name: pickPlain(props['Name'], 'title'),
        kategorie: pickMulti(props['Kategorie']),
        bewertung: pickSelect(props['Bewertung']),
        ziel: pickPlain(props['Ziel']),
        ablauf: pickPlain(props['Ablauf']),
        coachingTipp: pickPlain(props['Coaching-Tipp']),
        einsatzCount: pickRelations(props['Eingesetzt bei']).length
      };
    }).filter(u => u.name);
    return jsonResponse({ uebungen }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

// Convenience: alles in einem Call
async function handleGetDashboardData(request, env) {
  try {
    const [t, k, u, tu] = await Promise.all([
      notionQuery(DS_TRAININGS, env, { sorts: [{ property: 'Datum', direction: 'ascending' }] }),
      notionQuery(DS_KADER, env),
      notionQuery(DS_UEBUNGEN, env),
      notionQuery(DS_TURNIERE, env, { sorts: [{ property: 'Datum', direction: 'ascending' }] })
    ]);
    return jsonResponse({
      generated: new Date().toISOString(),
      trainingsRaw: t.results.length,
      kaderRaw: k.results.length,
      uebungenRaw: u.results.length,
      turniereRaw: tu.results.length,
      trainings: t.results,
      kader: k.results,
      uebungen: u.results,
      turniere: tu.results
    }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}


// --- Helpers ---

function handleCORS(request) {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.find(o => origin.startsWith(o)) || ALLOWED_ORIGINS[0];

  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}

function jsonResponse(data, status, request) {
  const origin = request?.headers?.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.find(o => origin.startsWith(o)) || ALLOWED_ORIGINS[0];

  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    }
  });
}
