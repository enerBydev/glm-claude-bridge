#!/usr/bin/env node
// ============================================================================
// session-mechanism-experiment.mjs — Experimento forense decisivo
// ¿La identidad de sesión (X-Chat-Id/X-User-Id/X-Token) cambia el enrutado
// del gateway internal-api.z.ai? ¿Y thinking:enabled devuelve reasoning?
//
// Matriz (pacing 5s; cuota 2 QPS / 30-10min):
//   A) baseline:      Bearer Z.ai + X-Z-AI-From            (bridge viejo)
//   B) sesión full:   + X-Chat-Id + X-User-Id + X-Token    (mecanismo SDK exacto)
//   C) sesión+think:  B + thinking:{type:'enabled'}
//   D) bearer-JWT:    Authorization: Bearer <JWT>          (variante exploratoria)
//   E) cutoff A vs B: "¿Conoces DeepSeek-R1?" en ambos modos
// Uso: node session-mechanism-experiment.mjs [A|B|C|D|E|all]
// ============================================================================

import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync('/etc/.z-ai-config', 'utf-8'));
const URL = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
const PACING_MS = Number(process.env.EXP_PACING_MS || 5200);

const nonce = () => Math.random().toString(36).slice(2, 8).toUpperCase();

function headers(mode) {
  const h = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.apiKey}`,
    'X-Z-AI-From': 'Z',
  };
  if (mode === 'session' || mode === 'session-think') {
    h['X-Chat-Id'] = cfg.chatId;
    h['X-User-Id'] = cfg.userId;
    h['X-Token'] = cfg.token;
  } else if (mode === 'bearer-jwt') {
    h['Authorization'] = `Bearer ${cfg.token}`;
  }
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(mode, body, label) {
  const t0 = Date.now();
  const res = await fetch(URL, {
    method: 'POST',
    headers: headers(mode),
    body: JSON.stringify(body),
  });
  const dt = Date.now() - t0;
  const quota = {};
  for (const [k, v] of res.headers.entries()) {
    if (/ratelimit|rate-limit|quota/i.test(k)) quota[k] = v;
  }
  const txt = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch {}
  const out = {
    label, mode, status: res.status, ms: dt,
    echo_model: json?.model ?? null,
    content: json?.choices?.[0]?.message?.content?.slice(0, 400) ?? txt.slice(0, 200),
    reasoning_present: !!json?.choices?.[0]?.message?.reasoning_content,
    reasoning_preview: (json?.choices?.[0]?.message?.reasoning_content || '').slice(0, 200),
    usage: json?.usage ?? null,
    quota,
  };
  return out;
}

function print(r) {
  console.log(`\n=== ${r.label} [modo=${r.mode}] → HTTP ${r.status} (${r.ms}ms)`);
  console.log(`  eco model  : ${r.echo_model}`);
  console.log(`  reasoning  : ${r.reasoning_present ? 'SÍ ← ' + JSON.stringify(r.reasoning_preview) : 'no'}`);
  console.log(`  usage      : ${JSON.stringify(r.usage)}`);
  console.log(`  quota      : ${JSON.stringify(r.quota)}`);
  console.log(`  contenido  : ${JSON.stringify(r.content)}`);
}

const experiments = {
  async A() {
    return call('baseline', {
      model: 'glm-5.3-flash', stream: false, max_tokens: 30,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: `Responde exactamente: OK-A nonce=${nonce()}` }],
    }, 'A) baseline (sin sesión)');
  },
  async B() {
    return call('session', {
      model: 'glm-5.3-flash', stream: false, max_tokens: 30,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: `Responde exactamente: OK-B nonce=${nonce()}` }],
    }, 'B) sesión full (mecanismo SDK)');
  },
  async C() {
    return call('session-think', {
      model: 'glm-5.3-flash', stream: false, max_tokens: 2000,
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: `Resuelve paso a paso: si 3 gatos cazan 3 ratones en 3 minutos, ¿cuántos gatos cazan 100 ratones en 100 minutos? nonce=${nonce()}` }],
    }, 'C) sesión + thinking ENABLED');
  },
  async D() {
    return call('bearer-jwt', {
      model: 'glm-5.3-flash', stream: false, max_tokens: 30,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: `Responde exactamente: OK-D nonce=${nonce()}` }],
    }, 'D) Bearer=JWT (exploratorio)');
  },
  async E() {
    const q = (n) => `¿Conoces DeepSeek-R1? Responde únicamente SÍ con su fecha de lanzamiento, o NO. nonce=${n}`;
    const a = await call('baseline', {
      model: 'glm-5.3-flash', stream: false, max_tokens: 80,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: q(nonce()) }],
    }, 'E1) cutoff SIN sesión');
    await sleep(PACING_MS);
    const b = await call('session', {
      model: 'glm-5.3-flash', stream: false, max_tokens: 80,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: q(nonce()) }],
    }, 'E2) cutoff CON sesión');
    return [a, b];
  },
};

const which = process.argv[2] || 'all';
const order = which === 'all' ? ['A', 'B', 'C', 'D', 'E'] : [which];
const results = [];
for (const key of order) {
  const r = await experiments[key]();
  if (Array.isArray(r)) { r.forEach(print); results.push(...r); }
  else { print(r); results.push(r); }
  if (key !== order[order.length - 1]) await sleep(PACING_MS);
}

fs.writeFileSync('/home/z/my-project/scripts/session-mechanism-results.json', JSON.stringify(results, null, 2));
console.log('\n[guardado] scripts/session-mechanism-results.json');

// Análisis automático
const a = results.find((r) => r.label.startsWith('A)'));
const b = results.find((r) => r.label.startsWith('B)'));
const c = results.find((r) => r.label.startsWith('C)'));
console.log('\n──── VEREDICTO ────');
if (a && b) {
  const sameQuota = JSON.stringify(a.quota) === JSON.stringify(b.quota);
  console.log(`- ¿Cuota distinta A vs B? ${sameQuota ? 'NO (mismo bucket)' : 'SÍ → identidad de sesión reconocida'}`);
  console.log(`  A quota: ${JSON.stringify(a.quota)}`);
  console.log(`  B quota: ${JSON.stringify(b.quota)}`);
}
if (c) console.log(`- ¿thinking:enabled produce reasoning? ${c.reasoning_present ? 'SÍ → modelo híbrido-thinking' : 'no observable'}`);
