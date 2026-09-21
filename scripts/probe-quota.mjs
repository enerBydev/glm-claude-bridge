#!/usr/bin/env node
// ============================================================================
// probe-quota.mjs — Sonda forense de cuota contra internal-api.z.ai
// Responde: ¿por qué el bridge ve 429 pero el chat interactivo no?
//  1. Captura TODOS los headers x-ratelimit-* del gateway en peticiones reales.
//  2. Mide el decremento entre 2 llamadas (¿qué bucket descuenta cada llamada?).
//  3. Estado de cada bucket AHORA (¿key-daily ya consumido temprano el día?
//     => compartido globalmente entre sandboxes).
// Coste: 2 llamadas mínimas (max_tokens=8) + espera anti-WAF de 3.5s.
// ============================================================================

import fs from 'node:fs';

const CFG_PATHS = [process.env.ZAI_CONFIG_PATH, '/etc/.z-ai-config'].filter(Boolean);
let cfg = null;
for (const p of CFG_PATHS) {
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf-8')); if (cfg.baseUrl) break; } catch {}
}
if (!cfg) { console.error('sin config de sesión'); process.exit(1); }

const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${cfg.apiKey}`,
  'X-Z-AI-From': 'Z',
};
if (cfg.chatId) headers['X-Chat-Id'] = cfg.chatId;
if (cfg.userId) headers['X-User-Id'] = cfg.userId;
if (cfg.token) headers['X-Token'] = cfg.token;

function fp(t) { return t ? String(t).slice(0, 10) + '…(' + String(t).length + ')' : 'sin'; }

console.log('=== CONTEXTO ===');
console.log('upstream:', url);
console.log('apiKey:', JSON.stringify(cfg.apiKey), '(placeholder compartido escrito por /start.sh)');
console.log('token:', fp(cfg.token), '| chatId:', cfg.chatId, '| userId:', cfg.userId);
console.log('hora UTC:', new Date().toISOString(), '| hora UTC+8:', new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00'));

const RATELIMIT_HEADERS = [
  'x-ratelimit-limit-daily', 'x-ratelimit-remaining-daily',
  'x-ratelimit-user-daily-limit', 'x-ratelimit-user-daily-remaining',
  'x-ratelimit-user-10min-limit', 'x-ratelimit-user-10min-remaining',
  'x-ratelimit-reset-daily', 'x-ratelimit-reset', 'retry-after',
  'x-message-id', 'ga-traceid',
];

async function call(nonce) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: `Di exactamente: OK-${nonce}` }],
      max_tokens: 8,
      stream: false,
    }),
  });
  const ms = Date.now() - t0;
  const hdrs = {};
  for (const h of RATELIMIT_HEADERS) { const v = res.headers.get(h); if (v != null) hdrs[h] = v; }
  // además: cualquier otro header x-ratelimit-* no listado
  for (const [k, v] of res.headers.entries()) {
    if (k.startsWith('x-ratelimit') && !(k in hdrs)) hdrs[k] = v;
  }
  let bodyTxt = '';
  try {
    const j = await res.json();
    bodyTxt = j?.choices?.[0]?.message?.content || JSON.stringify(j).slice(0, 200);
    if (j?.error) bodyTxt = 'ERROR: ' + JSON.stringify(j.error).slice(0, 300);
  } catch { bodyTxt = '(sin JSON)'; }
  return { status: res.status, ms, hdrs, bodyTxt, setCookie: res.headers.getSetCookie?.() || [] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = await call('A' + Date.now().toString(36));
console.log(`\n=== LLAMADA 1 === HTTP ${a.status} (${a.ms}ms)`);
console.log('respuesta:', String(a.bodyTxt).slice(0, 120));
for (const [k, v] of Object.entries(a.hdrs)) console.log(`  ${k} = ${v}`);

await sleep(3500);

const b = await call('B' + Date.now().toString(36));
console.log(`\n=== LLAMADA 2 === HTTP ${b.status} (${b.ms}ms)`);
console.log('respuesta:', String(b.bodyTxt).slice(0, 120));
for (const [k, v] of Object.entries(b.hdrs)) console.log(`  ${k} = ${v}`);

console.log('\n=== DELTAS (llamada1 -> llamada2) ===');
for (const k of Object.keys(a.hdrs)) {
  const na = Number(a.hdrs[k]), nb = Number(b.hdrs[k]);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
    console.log(`  ${k}: ${na} -> ${nb} (Δ ${nb - na})`);
  }
}

console.log('\n=== VEREDICTO ===');
const kd = b.hdrs['x-ratelimit-remaining-daily'];
const ud = b.hdrs['x-ratelimit-user-daily-remaining'];
const u10 = b.hdrs['x-ratelimit-user-10min-remaining'];
console.log(`key-daily restante: ${kd ?? '?'}  (límite conocido por worklog: 300/día, clave 'Z.ai' GLOBAL)`);
console.log(`user-daily restante: ${ud ?? '?'} (límite conocido por worklog: 200/día, tu user_id)`);
console.log(`user-10min restante: ${u10 ?? '?'} (límite conocido por worklog: 30/10min)`);
if (kd != null && Number(kd) < 250) {
  console.log('>> key-daily YA consumido sin que esta sesión lo haga => bucket de la clave compartido entre sandboxes de la plataforma.');
}
console.log('El chat interactivo (esta conversación) NO pasa por internal-api.z.ai: la inferencia');
console.log('ocurre platform-side (worklog 1-b: cero conexiones salientes del sandbox al gateway).');
