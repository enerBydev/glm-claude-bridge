#!/usr/bin/env node
// ============================================================================
// probe.mjs — GLM-Bridge: sonda de verificación del modelo real.
// Responde a la pregunta "¿qué modelo atiende DE VERDAD este gateway?"
// combinando dos evidencias independientes:
//   1. Eco del gateway (campo `model` de la respuesta) — puede ser cosmético.
//   2. Fingerprinting conductual de cutoff de conocimiento (objetivo).
// Uso: glm-bridge probe   (2 llamadas API por ejecución)
// ============================================================================

import { loadZaiConfig, upstreamHeaders, upstreamUrl } from './zai-config.mjs';

const cfg = loadZaiConfig();
const URL_ = upstreamUrl(cfg);
const HEADERS = upstreamHeaders(cfg);

async function call(body) {
  const t0 = Date.now();
  const res = await fetch(URL_, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const hdrs = {};
  for (const [k, v] of res.headers) hdrs[k] = v;
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { /* no-json */ }
  return { status: res.status, ms, hdrs, json };
}

function contentOf(json) {
  return json?.choices?.[0]?.message?.content || '';
}

const NONCE = Math.random().toString(36).slice(2, 8).toUpperCase();

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║        GLM-Bridge probe — ¿qué modelo sirve el gateway?      ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`upstream : ${URL_}`);
console.log(`nonce    : ${NONCE} (anti-caché)\n`);

// --- Sonda 1: eco + autodescripción + cabeceras -----------------------------
console.log('[1/2] Sonda de eco y autodescripción...');
const r1 = await call({
  messages: [{
    role: 'user',
    content:
      `Responde en exactamente 2 líneas.\n` +
      `Línea 1: "ECHO:${NONCE}" y nada más.\n` +
      `Línea 2: ¿De qué generación de la familia GLM formas parte y a cuántos tokens asciende tu ventana de contexto?`,
  }],
  max_tokens: 120, stream: false, thinking: { type: 'disabled' },
});

if (r1.status !== 200 || !r1.json?.choices) {
  console.error(`  ERROR ${r1.status}: ${JSON.stringify(r1.json || r1.hdrs).slice(0, 300)}`);
  process.exit(1);
}

const echoModel = r1.json.model || '(sin campo model)';
const selfDesc = contentOf(r1.json).split('\n').filter(Boolean).pop() || '';
const usage1 = r1.json.usage || {};
const rlHeaders = Object.entries(r1.hdrs)
  .filter(([k]) => /rate|limit|remain|quota|retry/i.test(k));

console.log(`  eco del gateway (model) : ${echoModel}`);
console.log(`  autodescripción         : ${selfDesc.trim().slice(0, 110)}`);
console.log(`  usage                   : prompt=${usage1.prompt_tokens} completion=${usage1.completion_tokens}`);
console.log(`  latencia                : ${r1.ms}ms`);
console.log(`  cabeceras de cuota      : ${rlHeaders.length ? rlHeaders.map(([k, v]) => `${k}=${v}`).join(' | ') : '(no expone)'}`);

await new Promise((r) => setTimeout(r, 2500)); // respetar rate limit

// --- Sonda 2: cutoff de conocimiento (discrimina generación GLM) -------------
console.log('\n[2/2] Sonda de cutoff de conocimiento...');
const r2 = await call({
  messages: [{
    role: 'user',
    content:
      `Contesta SOLO "LO CONOZCO: <fecha>" si sabes qué es, o "NO LO CONOZCO" si no.\n` +
      `a) DeepSeek-R1 (modelo de razonamiento de DeepSeek, nonce ${NONCE})`,
  }],
  max_tokens: 60, stream: false, thinking: { type: 'disabled' },
});
const cutoffAns = contentOf(r2.json).trim();
const knowsR1 = /conozco|know/i.test(cutoffAns) && !/no lo conozco|no conozco|don't|do not/i.test(cutoffAns);

console.log(`  ¿Conoce DeepSeek-R1 (ene-2025)? : ${cutoffAns.slice(0, 90) || '(vacío)'}`);

// --- Veredicto ---------------------------------------------------------------
// OJO: una sola sonda de cutoff es RUIDOSA (sampling > 0): el mismo backend ha
// respondido "no conozco R1" y "LO CONOZCO: 24/01/2025" en días distintos.
// La batería multi-test es la evidencia fiable; la sonda única es indicativa.
let verdict;
if (knowsR1) {
  verdict = 'indicios de conocimiento post-ene-2025 (GLM-4.5/4.6/5 posible)';
} else {
  verdict = 'sin conocimiento de ene-2025 → cohorte GLM-4-plus (2024) probable';
}

console.log('\n────────────────────────── VEREDICTO ──────────────────────────');
console.log(`etiqueta pedida  : (la que configures — el gateway la ignora)`);
console.log(`eco del gateway  : ${echoModel}  ← lo que el gateway DECLARA servir`);
console.log(`conducta (1 sonda): ${verdict}`);
console.log(`aviso            : sonda única = ruidosa; usa baterías multi-test`);
console.log(`                   para veredictos finos (ver scripts/behavioral-fingerprint.py).`);
console.log(`hecho sólido     : el SDK oficial de Z.ai nunca envía "model"; el campo`);
console.log(`                   es cosmético. Familia GLM/Zhipu confirmada en 100% de`);
console.log(`                   las autoidentificaciones sin system prompt.`);
console.log('────────────────────────────────────────────────────────────────');
