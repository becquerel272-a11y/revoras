/* ============================================================
   Revora — fonction serveur IA (Netlify Functions)
   La clé API reste ici, côté serveur. Le navigateur ne la voit jamais.

   Variables d'environnement (Netlify → Project configuration → Environment variables) :
     ANTHROPIC_API_KEY   clé Claude (prioritaire si les deux clés sont présentes)
     OPENAI_API_KEY      clé OpenAI
     AI_PROVIDER         facultatif : "anthropic" ou "openai" pour forcer le choix
     AI_MODEL            facultatif : modèle principal
     AI_MODEL_QUICK      facultatif : modèle rapide (corrections courtes)
     AI_MODEL_COMPLEX    facultatif : modèle pour les tâches difficiles
     ALLOWED_ORIGINS     facultatif : autres domaines autorisés, séparés par des virgules
   ============================================================ */

const DEFAULTS = {
  anthropic: { default: 'claude-haiku-4-5-20251001', quick: 'claude-haiku-4-5-20251001', complex: 'claude-sonnet-5-5' },
  openai: { default: 'gpt-5-mini', quick: 'gpt-5-nano', complex: 'gpt-5-mini' }
};
const MAX_BODY_BYTES = 5.5 * 1024 * 1024;   // limite des fonctions Netlify : 6 Mo
const MAX_TEXT_CHARS = 200000;
const MAX_IMAGES = 4;
const MAX_TOKENS = { quick: 1500, default: 4000, complex: 6000 };

const SYSTEM = `Tu es le moteur pédagogique de Revora, une application qui aide des élèves et des étudiants à réviser leurs propres cours.
Suis exactement les consignes et le format de sortie demandés dans le message de l'utilisateur.
Ne présente jamais comme venant du document une information qui n'y figure pas, et n'invente ni citation ni numéro de page.`;
const JSON_RULE = `\n\nIMPORTANT : ta réponse sera lue par un programme. Réponds uniquement avec une valeur JSON valide, sans texte avant ni après, sans bloc de code.`;

const env = k => {
  try { if (globalThis.Netlify && Netlify.env && Netlify.env.get(k)) return Netlify.env.get(k); } catch (e) { /* ignore */ }
  return process.env[k];
};

function provider() {
  const forced = (env('AI_PROVIDER') || '').toLowerCase();
  if (forced === 'openai' && env('OPENAI_API_KEY')) return 'openai';
  if (forced === 'anthropic' && env('ANTHROPIC_API_KEY')) return 'anthropic';
  if (env('ANTHROPIC_API_KEY')) return 'anthropic';
  if (env('OPENAI_API_KEY')) return 'openai';
  return null;
}
function model(p, tier) {
  const t = ['quick', 'complex'].includes(tier) ? tier : 'default';
  const key = t === 'quick' ? 'AI_MODEL_QUICK' : t === 'complex' ? 'AI_MODEL_COMPLEX' : 'AI_MODEL';
  return env(key) || (t !== 'default' && env('AI_MODEL')) || DEFAULTS[p][t];
}

const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
const fail = (status, code, message) => json(status, { error: code, message });

function originAllowed(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true; // requête du même site sans en-tête Origin (GET)
  let host;
  try { host = new URL(origin).host; } catch (e) { return false; }
  if (host === req.headers.get('host') || host === req.headers.get('x-forwarded-host')) return true;
  for (const u of [env('URL'), env('DEPLOY_PRIME_URL'), env('DEPLOY_URL')]) {
    try { if (u && new URL(u).host === host) return true; } catch (e) { /* ignore */ }
  }
  return (env('ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean).some(o => { try { return new URL(o).host === host; } catch (e) { return false; } });
}

/* Validation de la demande envoyée par l'application */
function parseInput(body) {
  let turns;
  if (typeof body.input === 'string') turns = [{ role: 'user', content: body.input }];
  else if (Array.isArray(body.input)) turns = body.input;
  else return null;
  const clean = [];
  let total = 0;
  for (const t of turns) {
    if (!t || (t.role !== 'user' && t.role !== 'assistant') || typeof t.content !== 'string' || !t.content.trim()) return null;
    total += t.content.length;
    const last = clean[clean.length - 1];
    if (last && last.role === t.role) last.content += '\n\n' + t.content; // les tours consécutifs du même rôle sont fusionnés
    else clean.push({ role: t.role, content: t.content });
  }
  if (!clean.length || clean[0].role !== 'user' || clean[clean.length - 1].role !== 'user') return null;
  if (total > MAX_TEXT_CHARS) return 'too_large';
  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES).filter(i => i && typeof i.data === 'string' && /^image\/(jpeg|png|webp|gif)$/.test(i.media_type)) : [];
  if (body.json) clean[clean.length - 1].content += JSON_RULE;
  return { turns: clean, images, tier: ['quick', 'complex'].includes(body.modelTier) ? body.modelTier : 'default' };
}

/* ---------- Appels aux fournisseurs ---------- */
async function callAnthropic(req, signal) {
  const messages = req.turns.map((t, i) => {
    if (i === req.turns.length - 1 && req.images.length) {
      return { role: 'user', content: [...req.images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), { type: 'text', text: t.content }] };
    }
    return { role: t.role, content: t.content };
  });
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model('anthropic', req.tier), max_tokens: MAX_TOKENS[req.tier], system: SYSTEM, messages, stream: true })
  });
}
async function callOpenAI(req, signal) {
  const messages = [{ role: 'system', content: SYSTEM }, ...req.turns.map((t, i) => {
    if (i === req.turns.length - 1 && req.images.length) {
      return { role: 'user', content: [{ type: 'text', text: t.content }, ...req.images.map(im => ({ type: 'image_url', image_url: { url: `data:${im.media_type};base64,${im.data}` } }))] };
    }
    return { role: t.role, content: t.content };
  })];
  const m = model('openai', req.tier);
  const body = { model: m, messages, stream: true, max_completion_tokens: MAX_TOKENS[req.tier] };
  if (/^(gpt-5|o\d)/.test(m)) body.reasoning_effort = env('OPENAI_REASONING_EFFORT') || 'minimal';
  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env('OPENAI_API_KEY')}` },
    body: JSON.stringify(body)
  });
}

/* Transforme le flux SSE du fournisseur en lignes JSON simples pour l'application :
   {"t":"texte"} … puis {"done":true,"truncated":false} ou {"error":"code"} */
function relay(upstream, p) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  return new ReadableStream({
    async start(controller) {
      const send = o => controller.enqueue(enc.encode(JSON.stringify(o) + '\n'));
      let buf = '', truncated = false, finished = false;
      const handle = data => {
        if (data === '[DONE]') { finished = true; return; }
        let ev; try { ev = JSON.parse(data); } catch (e) { return; }
        if (p === 'anthropic') {
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) send({ t: ev.delta.text });
          else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'max_tokens') truncated = true;
          else if (ev.type === 'message_stop') finished = true;
          else if (ev.type === 'error') { send({ error: ev.error && ev.error.type === 'overloaded_error' ? 'rate_limited' : 'upstream_error' }); finished = true; truncated = null; }
        } else {
          const ch = ev.choices && ev.choices[0];
          if (ch && ch.delta && typeof ch.delta.content === 'string' && ch.delta.content) send({ t: ch.delta.content });
          if (ch && ch.finish_reason === 'length') truncated = true;
          if (ch && ch.finish_reason) finished = true;
        }
      };
      try {
        const reader = upstream.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (line.startsWith('data:')) handle(line.slice(5).trim());
          }
        }
        if (buf.trim().startsWith('data:')) handle(buf.trim().slice(5).trim());
        if (truncated !== null) send(finished || truncated ? { done: true, truncated } : { error: 'upstream_error' });
      } catch (e) {
        send({ error: 'upstream_error' });
      }
      controller.close();
    }
  });
}

async function mapUpstreamError(res, p) {
  let detail = '';
  try { detail = (await res.text()).slice(0, 400); } catch (e) { /* ignore */ }
  console.error(`[revora-ai] ${p} ${res.status} ${detail}`);
  if (res.status === 401 || res.status === 403) return fail(503, 'sampling_disabled', "La clé API du serveur est invalide ou n'a pas accès à ce modèle.");
  if (res.status === 404) return fail(503, 'sampling_disabled', 'Le modèle configuré est introuvable (vérifie AI_MODEL).');
  if (res.status === 429 || res.status === 529) return fail(429, 'rate_limited', "L'IA est très sollicitée, réessaie dans un instant.");
  if (res.status === 400 && /too long|context|maximum|too large/i.test(detail)) return fail(413, 'prompt_too_large', 'Demande trop longue.');
  if (res.status === 400) return fail(400, 'invalid_request', 'Demande refusée par le fournisseur IA.');
  return fail(502, 'upstream_error', 'Le fournisseur IA ne répond pas.');
}

export default async (req) => {
  if (!originAllowed(req)) return fail(403, 'forbidden', 'Origine non autorisée.');
  const p = provider();
  if (req.method === 'GET') {
    return json(200, { ok: !!p, provider: p, images: !!p, maxImages: MAX_IMAGES, maxChars: MAX_TEXT_CHARS });
  }
  if (req.method !== 'POST') return fail(405, 'invalid_request', 'Méthode non autorisée.');
  if (!p) return fail(503, 'sampling_disabled', "Aucune clé API n'est configurée sur le serveur.");
  const len = +(req.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) return fail(413, 'prompt_too_large', 'Demande trop volumineuse.');
  let body;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return fail(413, 'prompt_too_large', 'Demande trop volumineuse.');
    body = JSON.parse(raw);
  } catch (e) { return fail(400, 'invalid_request', 'Demande illisible.'); }
  const input = parseInput(body || {});
  if (input === 'too_large') return fail(413, 'prompt_too_large', 'Demande trop longue.');
  if (!input) return fail(400, 'invalid_request', 'Demande mal formée.');
  let upstream;
  try {
    upstream = p === 'anthropic' ? await callAnthropic(input, req.signal) : await callOpenAI(input, req.signal);
  } catch (e) {
    console.error('[revora-ai] réseau', e);
    return fail(502, 'upstream_error', 'Le fournisseur IA ne répond pas.');
  }
  if (!upstream.ok) return mapUpstreamError(upstream, p);
  return new Response(relay(upstream, p), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-revora-tier': input.tier }
  });
};

export const config = {
  path: '/api/ai',
  // 20 requêtes par minute et par adresse IP : protège ton crédit contre les abus
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] }
};
