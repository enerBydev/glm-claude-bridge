#!/usr/bin/env node
// ============================================================================
// probe-methods.mjs — ¿existe un poller de cuota GRATIS?
// Prueba GET {base}/models y GET {base}/chat/completions: si devuelven los
// headers x-ratelimit-* SIN decrementar los buckets user, tenemos un poller
// de coste cero para esperar el reset diario sin quemar cuota.
// ============================================================================
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync('/etc/.z-ai-config', 'utf-8'));
const base = cfg.baseUrl.replace(/\/+$/, '');
const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${cfg.apiKey}`,
  'X-Z-AI-From': 'Z',
};
if (cfg.chatId) headers['X-Chat-Id'] = cfg.chatId;
if (cfg.userId) headers['X-User-Id'] = cfg.userId;
if (cfg.token) headers['X-Token'] = cfg.token;

const Q = ['x-ratelimit-remaining-daily', 'x-ratelimit-user-daily-remaining', 'x-ratelimit-user-10min-remaining'];
const snap = (r) => { const o = {}; for (const h of Q) o[h] = r.headers.get(h); return o; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function trial(name, url, opts) {
  const t0 = Date.now();
  let status = '?', hdrs = {}, body = '';
  try {
    const r = await fetch(url, opts);
    status = r.status; hdrs = snap(r);
    body = (await r.text()).slice(0, 120).replace(/\s+/g, ' ');
  } catch (e) { body = 'ERR ' + e.message; }
  console.log(`\n[${name}] HTTP ${status} (${Date.now() - t0}ms)`);
  for (const [k, v] of Object.entries(hdrs)) console.log(`   ${k} = ${v}`);
  console.log(`   body: ${body}`);
  return hdrs;
}

console.log('base:', base);
const h1 = await trial('GET /models', base + '/models', { method: 'GET', headers });
await sleep(3500);
const h2 = await trial('GET /chat/completions', base + '/chat/completions', { method: 'GET', headers });
await sleep(3500);
const h3 = await trial('POST /models (control por contraste)', base + '/models', { method: 'POST', headers, body: '{}' });
await sleep(3500);
// control: un POST /chat/completions mínimo SÍ debe quemar (verifica que el medidor funciona)
const h4 = await trial('POST /chat/completions (control que SÍ quema)', base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'x' }], max_tokens: 1 }) });

console.log('\n=== ANÁLISIS ===');
console.log('GET /models        →', JSON.stringify(h1));
console.log('GET /chat/complet. →', JSON.stringify(h2));
console.log('POST /models       →', JSON.stringify(h3));
console.log('POST /chat/compl.  →', JSON.stringify(h4), '(control: aquí user-daily DEBE bajar)');
console.log('\nSi GET /chat/completions devuelve 429 con headers PERO user-daily no bajó');
console.log('en los GET (solo bajó en el POST de control) => poller gratis encontrado.');
