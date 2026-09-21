#!/usr/bin/env node
// ============================================================================
// e2e.mjs — QA E2E del bridge SIN gateway real y SIN cuota.
// Monta: mock GLM (puerto 8790) + mock 2 (8792, para rotación de baseUrl)
//        + bridge real (8791) con .z-ai-config temporal inyectada por
//        ZAI_CONFIG_PATH. Ejercita el pipeline completo de forma determinista.
//
//   node tests/e2e.mjs        (exit 0 = todo OK)
// ============================================================================
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MOCK1 = 8790, MOCK2 = 8792, BRIDGE = 8791;
const B_URL = `http://127.0.0.1:${BRIDGE}`;
const M1 = `http://127.0.0.1:${MOCK1}`;
const M2 = `http://127.0.0.1:${MOCK2}`;

const procs = [];
let tmpDir = null;
const results = [];
let passed = 0;

function killAll() {
  // síncrono y contundente: SIGTERM + SIGKILL de respaldo (compatible con 'exit' handler)
  for (const { p } of procs) {
    try { p.kill('SIGTERM'); } catch {}
    try { p.kill('SIGKILL'); } catch {}
  }
}
// registro global: el cleanup corre AUNQUE el runner muera por EPIPE/exit
process.on('exit', killAll);
process.on('uncaughtException', (e) => { console.error('FATAL:', e); killAll(); process.exit(1); });

function startProc(name, cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push({ name, p });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (code) => { if (code && code !== 0) console.error(`[${name}] exit ${code}\n${out}`); });
  return p;
}
async function waitHttp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status === 500) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
async function mockCapture(base) {
  const r = await fetch(`${base}/__mock/requests`);
  return (await r.json()).requests;
}
async function mockMode(base, mode) {
  await fetch(`${base}/__mock/mode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
}
async function mockReset(base) {
  await fetch(`${base}/__mock/reset`, { method: 'POST' });
}

// ---- config temporal de sesión (la ÚNICA fuente de credenciales del test) ----
function writeSessionConfig(cfg) {
  const p = path.join(tmpDir, '.z-ai-config');
  fs.writeFileSync(p, JSON.stringify(cfg));
  // fuerza mtime distinto (la recarga del bridge es por mtime)
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(p, t, t);
  return p;
}

async function bridgePost(body) {
  return fetch(`${B_URL}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sseEvents(rawText) {
  const evs = [];
  for (const block of rawText.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    if (!lines.length) continue;
    const ev = {}, parts = {};
    for (const l of lines) {
      if (l.startsWith('event:')) ev.event = l.slice(6).trim();
      if (l.startsWith('data:')) parts.data = l.slice(5).trim();
    }
    if (ev.event && parts.data) { try { ev.data = JSON.parse(parts.data); } catch {} evs.push(ev); }
  }
  return evs;
}

async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ✓ ${name}`); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(`  ✗ ${name}: ${e.message}`); console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

// ============================================================================
async function main() {
  // pre-limpieza defensiva: si una ejecución previa dejó zombies en nuestros
  // puertos, los matamos (idempotente; falla silenciosa si no hay nada)
  try { spawn('pkill', ['-f', 'tests/mock-upstream.mjs']); } catch {}
  try { spawn('pkill', ['-f', 'bridge.mjs --glm-e2e']); } catch {}
  await new Promise((r) => setTimeout(r, 300));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-bridge-e2e-'));
  writeSessionConfig({
    baseUrl: `${M1}/v1`, apiKey: 'Z.ai',
    token: 'JWT-A', chatId: 'chat-e2e-1', userId: 'user-e2e',
  });

  startProc('mock1', process.execPath, [path.join(__dirname, 'mock-upstream.mjs')], { MOCK_PORT: String(MOCK1) });
  startProc('mock2', process.execPath, [path.join(__dirname, 'mock-upstream.mjs')], { MOCK_PORT: String(MOCK2) });
  startProc('bridge', process.execPath, [path.join(ROOT, 'bridge.mjs'), '--glm-e2e'], {
    GLM_BRIDGE_PORT: String(BRIDGE),
    ZAI_CONFIG_PATH: path.join(tmpDir, '.z-ai-config'),
    GLM_BRIDGE_MIN_INTERVAL_MS: '0',
    GLM_BRIDGE_RETRIES: '2',
    GLM_BRIDGE_RETRY_BASE_MS: '50',
    GLM_BRIDGE_EXHAUSTED_COOLDOWN_MS: '0', // circuito OFF en el bridge principal: los tests 12-17 no lo ejercitan (test 18 usa un bridge dedicado)
    GLM_MODEL: 'glm-5.3-flash',
  });
  if (!await waitHttp(`${B_URL}/health`)) throw new Error('bridge no arrancó');

  console.log('E2E glm-claude-bridge (mock upstream, cero cuota real)\n');

  // 1 ── health + identidad de sesión ---------------------------------------
  await test('health: ok + sesión visible (chatId/token/mtime)', async () => {
    const r = await (await fetch(`${B_URL}/health`)).json();
    assert.equal(r.status, 'ok');
    assert.equal(r.version, 6);
    assert.equal(r.provider, 'zai');
    assert.equal(r.session.chatId, 'chat-e2e-1');
    assert.match(r.session.token, /JWT-A/);
    assert.equal(r.model, 'glm-5.3-flash');
  });

  // 2 ── mensaje básico + cabeceras de sesión exactas ------------------------
  await test('mensaje básico: eco del mock + X-Token/X-Chat-Id correctos', async () => {
    const r = await bridgePost({ model: 'glm-5.3-flash', max_tokens: 50, messages: [{ role: 'user', content: 'hola mock' }] });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.content[0].text, 'MOCK-OK hola mock');
    assert.equal(j.role, 'assistant');
    assert.equal(j.usage.input_tokens, 11);
    const caps = await mockCapture(M1);
    const last = caps[caps.length - 1];
    assert.equal(last.headers['x-token'], 'JWT-A');
    assert.equal(last.headers['x-chat-id'], 'chat-e2e-1');
    assert.equal(last.headers['x-z-ai-from'], 'Z');
    assert.ok(last.url.endsWith('/chat/completions'), `url upstream inesperada: ${last.url}`);
  });

  // 3 ── mapeo de modelos (no-glm → sesión; glm-* → tal cual) ----------------
  await test('mapeo de modelos: claude-* → modelo de sesión; glm-* → literal', async () => {
    await bridgePost({ model: 'claude-sonnet-4-5', max_tokens: 20, messages: [{ role: 'user', content: 'x' }] });
    await bridgePost({ model: 'glm-4.6', max_tokens: 20, messages: [{ role: 'user', content: 'y' }] });
    const caps = await mockCapture(M1);
    assert.equal(caps[caps.length - 2].body.model, 'glm-5.3-flash'); // mapeado
    assert.equal(caps[caps.length - 1].body.model, 'glm-4.6');       // literal
  });

  // 4 ── tool calling completo ----------------------------------------------
  await test('tool calling: tool_use con nombre+input JSON parseado', async () => {
    const r = await bridgePost({
      model: 'glm-5.3-flash', max_tokens: 100,
      tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'MOCK:TOOL ejecuta ls' }],
    });
    const j = await r.json();
    assert.equal(j.stop_reason, 'tool_use');
    const tool = j.content.find((b) => b.type === 'tool_use');
    assert.equal(tool.name, 'Bash');
    assert.deepEqual(tool.input, { command: 'echo mock-tool-ok' });
    assert.match(tool.id, /^toolu_/);
  });

  // 5 ── thinking nativo (reasoning_content → bloque thinking primero) -------
  await test('thinking: bloque thinking ANTES del texto, con signature', async () => {
    const r = await bridgePost({ model: 'glm-5.3-flash', max_tokens: 100, messages: [{ role: 'user', content: 'MOCK:THINK piensa' }] });
    const j = await r.json();
    assert.equal(j.content[0].type, 'thinking');
    assert.ok(j.content[0].thinking.length > 0);
    assert.ok('signature' in j.content[0]);
    assert.equal(j.content[1].type, 'text');
    assert.equal(j.content[1].text, 'MOCK-THINK-OK');
  });

  // 6 ── streaming sintético (SSE Anthropic válido) ---------------------------
  await test('streaming: secuencia SSE message_start→text_delta→message_stop', async () => {
    const r = await bridgePost({ model: 'glm-5.3-flash', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'flujo' }] });
    assert.equal(r.headers.get('content-type'), 'text/event-stream');
    const evs = sseEvents(await r.text());
    const names = evs.map((e) => e.event);
    assert.equal(names[0], 'message_start');
    assert.equal(names[names.length - 1], 'message_stop');
    assert.ok(names.includes('content_block_start') && names.includes('content_block_delta'));
    const textDelta = evs.find((e) => e.data?.delta?.type === 'text_delta');
    assert.match(textDelta.data.delta.text, /MOCK-OK/);
    const stop = evs.find((e) => e.event === 'message_delta');
    assert.equal(stop.data.delta.stop_reason, 'end_turn');
  });

  // 7 ── streaming con thinking + tool_use en SSE -----------------------------
  await test('streaming tool_use: input_json_delta presente', async () => {
    const r = await bridgePost({ model: 'glm-5.3-flash', max_tokens: 100, stream: true, tools: [{ name: 'Bash', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'MOCK:TOOL x' }] });
    const evs = sseEvents(await r.text());
    const ijd = evs.find((e) => e.data?.delta?.type === 'input_json_delta');
    assert.ok(ijd, 'falta input_json_delta');
    assert.deepEqual(JSON.parse(ijd.data.delta.partial_json), { command: 'echo mock-tool-ok' });
  });

  // 8 ── count_tokens ---------------------------------------------------------
  await test('count_tokens: estimación local numérica', async () => {
    const r = await fetch(`${B_URL}/v1/messages/count_tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hola mundo' }] }) });
    const j = await r.json();
    assert.ok(Number.isFinite(j.input_tokens) && j.input_tokens > 0);
  });

  // 9 ── routing de visión -----------------------------------------------------
  await test('visión: imagen base64 → /chat/completions/vision', async () => {
    const r = await bridgePost({
      model: 'glm-5.3-flash', max_tokens: 50,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } },
        { type: 'text', text: 'MOCK: que ves' },
      ] }],
    });
    const j = await r.json();
    assert.equal(j.model, 'glm-5.3-flash');
    const caps = await mockCapture(M1);
    assert.ok(caps[caps.length - 1].url.endsWith('/chat/completions/vision'), `ruta visión incorrecta: ${caps[caps.length - 1].url}`);
  });

  // 10 ── ROTACIÓN DE CREDENCIALES EN VIVO (core v3, sin reinicio) ------------
  await test('rotación de credenciales: token nuevo usado en la SIGUIENTE petición sin reiniciar', async () => {
    await mockReset(M1);
    writeSessionConfig({ baseUrl: `${M1}/v1`, apiKey: 'Z.ai', token: 'JWT-B', chatId: 'chat-e2e-2', userId: 'user-e2e' });
    await new Promise((r) => setTimeout(r, 120)); // margen para que mtime cambie
    const r = await bridgePost({ model: 'glm-5.3-flash', max_tokens: 20, messages: [{ role: 'user', content: 'post-rotacion' }] });
    assert.equal((await r.json()).content[0].text, 'MOCK-OK post-rotacion');
    const caps = await mockCapture(M1);
    assert.equal(caps[0].headers['x-token'], 'JWT-B');
    assert.equal(caps[0].headers['x-chat-id'], 'chat-e2e-2');
    const h = await (await fetch(`${B_URL}/health`)).json();
    assert.match(h.session.token, /JWT-B/);
  });

  // 11 ── ROTACIÓN DE BASEURL EN VIVO (core v4, sin reinicio) -----------------
  await test('rotación de baseUrl: la petición llega al NUEVO upstream sin reiniciar', async () => {
    const before = (await mockCapture(M2)).length;
    writeSessionConfig({ baseUrl: `${M2}/v1`, apiKey: 'Z.ai', token: 'JWT-C', chatId: 'chat-e2e-3', userId: 'user-e2e' });
    await new Promise((r) => setTimeout(r, 120));
    const r = await bridgePost({ model: 'glm-5.3-flash', max_tokens: 20, messages: [{ role: 'user', content: 'upstream-nuevo' }] });
    assert.equal((await r.json()).content[0].text, 'MOCK-OK upstream-nuevo');
    const after = await mockCapture(M2);
    assert.equal(after.length, before + 1);
    assert.equal(after[after.length - 1].headers['x-token'], 'JWT-C');
  });

  // 12 ── fail-fast 429 con daily agotado (1 sola llamada upstream) ------------
  await test('fail-fast 429: daily=0 → UNA sola petición upstream, sin quemar cuota', async () => {
    await mockReset(M2);           // reset ANTES (reset restaura modo normal)
    await mockMode(M2, 'always-429');
    const r = await bridgePost({ model: 'glm-5.3-flash', max_tokens: 20, messages: [{ role: 'user', content: 'cuota-cero' }] });
    assert.equal(r.status, 429);
    const caps = await mockCapture(M2);
    assert.equal(caps.length, 1, `esperaba 1 intento, hubo ${caps.length}`);
    await mockMode(M2, 'normal');
  });

  // 13 ── 401 del upstream → error Anthropic de autenticación ------------------
  await test('upstream 401 (sin X-Token) → authentication_error de Anthropic', async () => {
    await mockMode(M2, 'auth-required');
    writeSessionConfig({ baseUrl: `${M2}/v1`, apiKey: 'Z.ai', chatId: 'chat-e2e-4', userId: 'user-e2e' }); // sin token
    await new Promise((r) => setTimeout(r, 120));
    const r = await bridgePost({ model: 'glm-5.3-flash', max_tokens: 20, messages: [{ role: 'user', content: 'sin-token' }] });
    assert.equal(r.status, 401);
    const j = await r.json();
    assert.equal(j.error.type, 'authentication_error');
    await mockMode(M2, 'normal');
  });

  // 14 ── recuperación tras restaurar credenciales ------------------------------
  await test('recuperación: restauradas las creds, el bridge vuelve a servir (v4 se adapta)', async () => {
    writeSessionConfig({ baseUrl: `${M1}/v1`, apiKey: 'Z.ai', token: 'JWT-D', chatId: 'chat-e2e-5', userId: 'user-e2e' });
    await new Promise((r) => setTimeout(r, 120));
    const r = await bridgePost({ model: 'glm-5.3-flash', max_tokens: 20, messages: [{ role: 'user', content: 'recuperado' }] });
    const j = await r.json();
    assert.equal(j.content[0].text, 'MOCK-OK recuperado');
  });

  // 15 ── fachada ultracode: claude-opus-5 / claude-fable-5 → modelo sesión --
  await test('fachada ultra: claude-opus-5 y claude-fable-5 → modelo de sesión', async () => {
    await bridgePost({ model: 'claude-opus-5', max_tokens: 20, messages: [{ role: 'user', content: 'ultra-opus' }] });
    await bridgePost({ model: 'claude-fable-5', max_tokens: 20, messages: [{ role: 'user', content: 'ultra-fable' }] });
    const caps = await mockCapture(M1);
    assert.equal(caps[caps.length - 2].body.model, 'glm-5.3-flash', 'opus no mapeado');
    assert.equal(caps[caps.length - 1].body.model, 'glm-5.3-flash', 'fable no mapeado');
  });

  // 16 ── thinking por effort (ultracode) → GLM thinking activado -------------
  await test('thinking type:effort (ultracode) → upstream thinking enabled', async () => {
    const r = await bridgePost({
      model: 'claude-opus-5', max_tokens: 50,
      thinking: { type: 'effort', effort: 'xhigh' },
      messages: [{ role: 'user', content: 'esfuerzo xhigh' }],
    });
    assert.equal(r.status, 200);
    const caps = await mockCapture(M1);
    assert.equal(caps[caps.length - 1].body.thinking?.type, 'enabled', 'effort no honrado como thinking');
  });

  // 17 ── workflow: Task tool_call para spawn de subagentes -------------------
  await test('workflow: marcador MOCK:TASK → tool_use Task (subagente determinista)', async () => {
    const r = await bridgePost({
      model: 'glm-5.3-flash', max_tokens: 100,
      tools: [{ name: 'Task', description: 'spawn subagent', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'MOCK:TASK lanza un subagente' }],
    });
    const j = await r.json();
    assert.equal(j.stop_reason, 'tool_use');
    const tool = j.content.find((b) => b.type === 'tool_use');
    assert.equal(tool.name, 'Task');
    assert.equal(tool.input.run_in_background, false);
    assert.match(tool.input.prompt, /MOCK-SUBAGENT-OK/);
    assert.equal(tool.input.subagent_type, 'general-purpose');
  });

  // 18 ── circuit breaker: daily=0 → 429 local SIN upstream durante cooldown ---
  await test('circuit breaker: daily=0 → 429 local sin upstream durante el cooldown, sondeo al expirar', async () => {
    await mockReset(M2);
    await mockMode(M2, 'always-429');
    const CB_PORT = 8795;
    const CB_URL = `http://127.0.0.1:${CB_PORT}`;
    const cbCfg = path.join(tmpDir, 'cb-.z-ai-config');
    fs.writeFileSync(cbCfg, JSON.stringify({ baseUrl: `${M2}/v1`, apiKey: 'Z.ai', token: 'JWT-CB', chatId: 'chat-e2e-cb', userId: 'user-e2e' }));
    startProc('bridge-cb', process.execPath, [path.join(ROOT, 'bridge.mjs'), '--glm-e2e'], {
      GLM_BRIDGE_PORT: String(CB_PORT),
      ZAI_CONFIG_PATH: cbCfg,
      GLM_BRIDGE_MIN_INTERVAL_MS: '0',
      GLM_BRIDGE_RETRIES: '2',
      GLM_BRIDGE_RETRY_BASE_MS: '50',
      GLM_BRIDGE_EXHAUSTED_COOLDOWN_MS: '2500',
      GLM_MODEL: 'glm-5.3-flash',
    });
    if (!await waitHttp(`${CB_URL}/health`)) throw new Error('bridge-cb no arrancó');
    const cbPost = (content) => fetch(`${CB_URL}/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3-flash', max_tokens: 20, messages: [{ role: 'user', content }] }),
    });
    // 1ª petición: cruza al upstream (1 intento, fail-fast) y ARMA el circuito
    const r1 = await cbPost('cb-1');
    assert.equal(r1.status, 429);
    // 2ª y 3ª DURANTE el cooldown: 429 local, upstream intacto (coste de cuota cero)
    const r2 = await cbPost('cb-2');
    const r3 = await cbPost('cb-3');
    assert.equal(r2.status, 429);
    assert.equal(r3.status, 429);
    assert.match(r2.headers.get('content-type') || '', /json/);
    let caps = await mockCapture(M2);
    assert.equal(caps.length, 1, `durante el cooldown esperaba 1 intento upstream total, hubo ${caps.length}`);
    // /health refleja el circuito abierto
    const h = await (await fetch(`${CB_URL}/health`)).json();
    assert.ok(h.circuit && h.circuit.key_daily_open_until, 'health debe exponer circuito abierto');
    // expira el cooldown → 1 petición de sondeo cruza al upstream (y re-arma)
    await new Promise((r) => setTimeout(r, 2700));
    const r4 = await cbPost('cb-4');
    assert.equal(r4.status, 429);
    caps = await mockCapture(M2);
    assert.equal(caps.length, 2, `tras el cooldown esperaba 2 intentos upstream total, hubo ${caps.length}`);
    await mockMode(M2, 'normal');
  });

  // 19 ── BYOK: provider=openai e2e completo ---------------------------------
  await test('BYOK: provider=openai — mapeo main/small, Bearer, sin cabeceras/thinking zai, streaming, tools, 401/429-sin-circuito/404', async () => {
    const MOCK3 = 8796, BYOK_PORT = 8797;
    const M3 = `http://127.0.0.1:${MOCK3}`;
    const Y_URL = `http://127.0.0.1:${BYOK_PORT}`;
    startProc('mock3', process.execPath, [path.join(__dirname, 'mock-upstream.mjs')], { MOCK_PORT: String(MOCK3) });
    startProc('bridge-byok', process.execPath, [path.join(ROOT, 'bridge.mjs'), '--glm-e2e'], {
      GLM_BRIDGE_PORT: String(BYOK_PORT),
      GLM_BRIDGE_PROVIDER: 'openai',
      GLM_BRIDGE_UPSTREAM_BASE_URL: `${M3}/v1`,
      GLM_BRIDGE_UPSTREAM_API_KEY: 'sk-mock-e2e',
      GLM_BRIDGE_UPSTREAM_MODEL: 'byok-main-model',
      GLM_BRIDGE_UPSTREAM_MODEL_SMALL: 'byok-small-model',
      ZAI_CONFIG_PATH: path.join(tmpDir, 'no-existe.cfg'), // prueba: BYOK NO necesita sesión z.ai
      GLM_BRIDGE_MIN_INTERVAL_MS: '0',
      GLM_BRIDGE_RETRIES: '2',
      GLM_BRIDGE_RETRY_BASE_MS: '50',
    });
    if (!await waitHttp(`${Y_URL}/health`)) throw new Error('bridge-byok no arrancó');
    const yPost = (body) => fetch(`${Y_URL}/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const h = await (await fetch(`${Y_URL}/health`)).json();
    assert.equal(h.provider, 'openai');
    assert.equal(h.status, 'ok');                       // ok SIN sesión z.ai
    assert.equal(h.upstream_model, 'byok-main-model');
    assert.equal(h.upstream_auth, 'bearer');
    assert.equal(h.session, null);
    assert.equal(h.circuit.enabled, false);             // breaker zai desactivado
    // mapeo de modelos: principal vs clase haiku/small
    await yPost({ model: 'glm-5.3-flash', max_tokens: 50, messages: [{ role: 'user', content: 'hola byok' }] });
    await yPost({ model: 'claude-3-5-haiku-latest', max_tokens: 50, messages: [{ role: 'user', content: 'fondo' }] });
    let caps = await mockCapture(M3);
    assert.equal(caps[caps.length - 2].body.model, 'byok-main-model', 'mapeo principal');
    assert.equal(caps[caps.length - 1].body.model, 'byok-small-model', 'mapeo small/haiku');
    const last = caps[caps.length - 1];
    assert.equal(last.headers['authorization'], 'Bearer sk-mock-e2e', 'auth Bearer estándar');
    assert.ok(!('x-token' in last.headers), 'sin X-Token');
    assert.ok(!('x-z-ai-from' in last.headers), 'sin X-Z-AI-From');
    assert.ok(!('thinking' in last.body), 'sin campo thinking propietario');
    // respuesta + etiqueta preservada
    const j = await (await yPost({ model: 'byok-main-model', max_tokens: 50, messages: [{ role: 'user', content: 'eco byok' }] })).json();
    assert.equal(j.content[0].text, 'MOCK-OK eco byok');
    assert.equal(j.model, 'byok-main-model');
    // streaming sintético
    const rs = await yPost({ model: 'byok-main-model', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'flujo byok' }] });
    assert.equal(rs.headers.get('content-type'), 'text/event-stream');
    const evs = sseEvents(await rs.text());
    assert.equal(evs[0].event, 'message_start');
    assert.equal(evs[evs.length - 1].event, 'message_stop');
    // tool calling
    const jt = await (await yPost({ model: 'byok-main-model', max_tokens: 100, tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'MOCK:TOOL byok' }] })).json();
    assert.equal(jt.stop_reason, 'tool_use');
    assert.equal(jt.content.find((b) => b.type === 'tool_use').name, 'Bash');
    // 401 estilo OpenAI → passthrough del mensaje del proveedor
    await mockMode(M3, 'bearer-auth-required');
    const r401 = await yPost({ model: 'byok-main-model', max_tokens: 50, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r401.status, 401);
    assert.equal((await r401.json()).error.type, 'authentication_error');
    await mockMode(M3, 'normal');
    // 429 SIN fail-fast/circuito zai: 1+2 reintentos = 3 intentos upstream
    await mockReset(M3);
    await mockMode(M3, 'always-429');
    const r429 = await yPost({ model: 'byok-main-model', max_tokens: 50, messages: [{ role: 'user', content: 'y' }] });
    assert.equal(r429.status, 429);
    assert.equal((await mockCapture(M3)).length, 3, 'BYOK debe reintentar (sin fail-fast zai)');
    const h2 = await (await fetch(`${Y_URL}/health`)).json();
    assert.equal(h2.circuit.key_daily_open_until, null, 'sin circuito zai en BYOK');
    await mockMode(M3, 'normal');
    await mockReset(M3);
    // 404 modelo inexistente → not_found_error
    await mockMode(M3, 'model-not-found');
    const r404 = await yPost({ model: 'no-existe', max_tokens: 50, messages: [{ role: 'user', content: 'z' }] });
    assert.equal(r404.status, 404);
    assert.equal((await r404.json()).error.type, 'not_found_error');
    await mockMode(M3, 'normal');
  });

  // 20 ── auto-detección + MODEL_MAP + precedencia explícita ------------------
  await test('BYOK: auto-detección por BASE_URL, MODEL_MAP con precedencia y provider=zai explícito gana', async () => {
    const M3 = 'http://127.0.0.1:8796'; // mock3 ya arrancado en el test 19
    // 20a+20c: auto-detección (sin GLM_BRIDGE_PROVIDER) + MODEL_MAP
    const A_URL = 'http://127.0.0.1:8798';
    startProc('bridge-auto', process.execPath, [path.join(ROOT, 'bridge.mjs'), '--glm-e2e'], {
      GLM_BRIDGE_PORT: '8798',
      GLM_BRIDGE_UPSTREAM_BASE_URL: `${M3}/v1`,
      GLM_BRIDGE_UPSTREAM_API_KEY: 'sk-auto',
      GLM_BRIDGE_UPSTREAM_MODEL: 'byok-main-model',
      GLM_BRIDGE_MODEL_MAP: '^claude-opus.*=byok-premium',
      ZAI_CONFIG_PATH: path.join(tmpDir, 'no-existe.cfg'),
      GLM_BRIDGE_MIN_INTERVAL_MS: '0',
    });
    if (!await waitHttp(`${A_URL}/health`)) throw new Error('bridge-auto no arrancó');
    const ha = await (await fetch(`${A_URL}/health`)).json();
    assert.equal(ha.provider, 'openai', 'auto-detección por BASE_URL');
    const aPost = (body) => fetch(`${A_URL}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await aPost({ model: 'claude-opus-5', max_tokens: 20, messages: [{ role: 'user', content: 'm1' }] });
    await aPost({ model: 'claude-sonnet-4-5', max_tokens: 20, messages: [{ role: 'user', content: 'm2' }] });
    await aPost({ model: 'claude-3-5-haiku-latest', max_tokens: 20, messages: [{ role: 'user', content: 'm3' }] });
    const caps = await mockCapture(M3);
    assert.equal(caps[caps.length - 3].body.model, 'byok-premium', 'MODEL_MAP precede al tier');
    assert.equal(caps[caps.length - 2].body.model, 'byok-main-model', 'sin match → main');
    assert.equal(caps[caps.length - 1].body.model, 'byok-main-model', 'small sin override → main');
    // 20b: provider=zai explícito GANA aunque BASE_URL esté definida
    const zCfg = path.join(tmpDir, 'zai-.z-ai-config');
    fs.writeFileSync(zCfg, JSON.stringify({ baseUrl: `${M1}/v1`, apiKey: 'Z.ai', token: 'JWT-Z', chatId: 'chat-e2e-z', userId: 'user-e2e' }));
    const Z_URL = 'http://127.0.0.1:8799';
    startProc('bridge-zai', process.execPath, [path.join(ROOT, 'bridge.mjs'), '--glm-e2e'], {
      GLM_BRIDGE_PORT: '8799',
      GLM_BRIDGE_PROVIDER: 'zai',
      GLM_BRIDGE_UPSTREAM_BASE_URL: `${M3}/v1`, // DEBE ser ignorado
      ZAI_CONFIG_PATH: zCfg,
      GLM_BRIDGE_MIN_INTERVAL_MS: '0',
      GLM_MODEL: 'glm-5.3-flash',
    });
    if (!await waitHttp(`${Z_URL}/health`)) throw new Error('bridge-zai no arrancó');
    const hz = await (await fetch(`${Z_URL}/health`)).json();
    assert.equal(hz.provider, 'zai');
    await mockReset(M1);
    const rz = await fetch(`${Z_URL}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'glm-5.3-flash', max_tokens: 20, messages: [{ role: 'user', content: 'sesion' }] }) });
    assert.equal((await rz.json()).content[0].text, 'MOCK-OK sesion');
    const capsZ = await mockCapture(M1);
    assert.equal(capsZ.length, 1);
    assert.equal(capsZ[0].headers['x-token'], 'JWT-Z', 'la petición fue al upstream de SESIÓN, no al BYOK');
  });

  // 21+22 ── short-circuit: títulos y llamadas pequeñas EN LOCAL --------------
  await test('short-circuit: título json_schema + genérica respondidos EN LOCAL con upstream muerto; fronteras no se tocan', async () => {
    const SC_URL = 'http://127.0.0.1:8801';
    startProc('bridge-sc', process.execPath, [path.join(ROOT, 'bridge.mjs'), '--glm-e2e'], {
      GLM_BRIDGE_PORT: '8801',
      GLM_BRIDGE_PROVIDER: 'openai',
      GLM_BRIDGE_UPSTREAM_BASE_URL: 'http://127.0.0.1:9', // upstream MUERTO a propósito
      GLM_BRIDGE_UPSTREAM_MODEL: 'x',
      GLM_BRIDGE_SHORTCIRCUIT_SMALL: 'true',
      GLM_BRIDGE_SHORTCIRCUIT_MAX_TOKENS: '64',
      GLM_BRIDGE_MIN_INTERVAL_MS: '0',
      GLM_BRIDGE_RETRIES: '0',
      GLM_BRIDGE_RETRY_BASE_MS: '10',
    });
    if (!await waitHttp(`${SC_URL}/health`)) throw new Error('bridge-sc no arrancó');
    const scPost = (body) => fetch(`${SC_URL}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const titleBody = (where, withBranch, stream = false) => {
      const fmt = {
        type: 'json_schema',
        schema: withBranch
          ? { type: 'object', required: ['title', 'branch'], properties: { title: { type: 'string' }, branch: { type: 'string' } } }
          : { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
      };
      const b = { model: 'claude-haiku-4-5', max_tokens: 1024, stream, messages: [{ role: 'user', content: '<session>meta-irrelevante</session>\nArreglar el login de auth.ts' }] };
      if (where === 'output_config') b.output_config = { format: fmt };
      else b.output_format = fmt;
      return b;
    };
    // 21a: título (output_config.format) → 200 LOCAL aunque el upstream esté muerto
    const t1 = await scPost(titleBody('output_config', false));
    assert.equal(t1.status, 200, `título debía responderse en local: ${t1.status}`);
    const jt1 = await t1.json();
    assert.equal(jt1.content[0].type, 'text');
    const parsed = JSON.parse(jt1.content[0].text);
    assert.ok(parsed.title && parsed.title.length >= 1 && parsed.title.length <= 60, 'título JSON válido');
    assert.match(parsed.title, /Arreglar/i);
    assert.ok(!('branch' in parsed), 'sin branch si el schema no lo pide');
    // 21b: título con branch (output_format deprecado, aceptado igual)
    const jt2 = await (await scPost(titleBody('output_format', true))).json();
    const p2 = JSON.parse(jt2.content[0].text);
    assert.match(p2.branch, /^claude\/[a-z0-9-]+$/, 'branch slug');
    // 21c: título con stream → SSE sintético local
    const t3 = await scPost(titleBody('output_config', false, true));
    assert.equal(t3.headers.get('content-type'), 'text/event-stream');
    const evs = sseEvents(await t3.text());
    assert.equal(evs[evs.length - 1].event, 'message_stop');
    // 22a: genérica max_tokens=64 sin tools → 200 local con marcador honesto
    const g1 = await scPost({ model: 'x', max_tokens: 64, messages: [{ role: 'user', content: 'clasifica esto' }] });
    assert.equal(g1.status, 200);
    const jg1 = await g1.json();
    assert.match(jg1.content[0].text, /^\[glm-bridge\]/, 'marcador de respuesta local');
    // 22b: FRONTERA — con tools (aunque max_tokens sea 64) → NO short-circuit → 502 (upstream muerto)
    const n1 = await scPost({ model: 'x', max_tokens: 64, tools: [{ name: 'Bash', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'con tools' }] });
    assert.equal(n1.status, 502, 'con tools NO debe haber short-circuit');
    // 22c: FRONTERA — max_tokens grande sin tools → NO short-circuit → 502
    const n2 = await scPost({ model: 'x', max_tokens: 32000, messages: [{ role: 'user', content: 'grande' }] });
    assert.equal(n2.status, 502, 'max_tokens grande NO debe tener short-circuit');
    // contadores en /health
    const hsc = await (await fetch(`${SC_URL}/health`)).json();
    assert.equal(hsc.shortcircuit.enabled, true);
    assert.ok(hsc.shortcircuit.answered_total >= 4, 'contadores: ' + JSON.stringify(hsc.shortcircuit.by_kind));
    assert.ok(hsc.shortcircuit.by_kind.title >= 3 && hsc.shortcircuit.by_kind.generic >= 1);
  });

  // 23 ── presupuesto diario: corte local + persistencia entre reinicios -------
  await test('presupuesto diario: 2 POSTs permitidos, 3º 429 local, persiste entre reinicios del bridge', async () => {
    const M3 = 'http://127.0.0.1:8796';
    const BG_URL = 'http://127.0.0.1:8802';
    const stateDir = path.join(tmpDir, 'budget-state');
    const env = {
      GLM_BRIDGE_PORT: '8802',
      GLM_BRIDGE_PROVIDER: 'openai',
      GLM_BRIDGE_UPSTREAM_BASE_URL: `${M3}/v1`,
      GLM_BRIDGE_UPSTREAM_API_KEY: 'sk-budget',
      GLM_BRIDGE_UPSTREAM_MODEL: 'byok-main-model',
      GLM_BRIDGE_DAILY_BUDGET: '2',
      GLM_BRIDGE_STATE_DIR: stateDir,
      GLM_BRIDGE_MIN_INTERVAL_MS: '0',
      GLM_BRIDGE_RETRIES: '0',
    };
    await mockReset(M3);
    startProc('bridge-budget', process.execPath, [path.join(ROOT, 'bridge.mjs'), '--glm-e2e'], env);
    if (!await waitHttp(`${BG_URL}/health`)) throw new Error('bridge-budget no arrancó');
    const bPost = (c) => fetch(`${BG_URL}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'byok-main-model', max_tokens: 50, messages: [{ role: 'user', content: c }] }) });
    const p1 = await bPost('b1');
    const p2 = await bPost('b2');
    assert.equal(p1.status, 200);
    assert.equal(p2.status, 200);
    const p3 = await bPost('b3');
    assert.equal(p3.status, 429);
    assert.match((await p3.json()).error.message, /presupuesto propio/, 'mensaje de presupuesto propio');
    assert.equal((await mockCapture(M3)).length, 2, 'sólo 2 POSTs cruzaron al upstream');
    const h1 = await (await fetch(`${BG_URL}/health`)).json();
    assert.equal(h1.budget.enabled, true);
    assert.equal(h1.budget.used, 2);
    assert.equal(h1.budget.remaining, 0);
    // reinicio con el MISMO state-dir → el contador NO se reinicia (anti doble-conteo)
    const mine = procs.find((x) => x.name === 'bridge-budget');
    try { mine.p.kill('SIGKILL'); } catch {}
    startProc('bridge-budget-2', process.execPath, [path.join(ROOT, 'bridge.mjs'), '--glm-e2e'], env);
    if (!await waitHttp(`${BG_URL}/health`)) throw new Error('bridge-budget-2 no arrancó');
    const p4 = await bPost('b4');
    assert.equal(p4.status, 429, 'tras reiniciar, el presupuesto sigue agotado');
    assert.equal((await mockCapture(M3)).length, 2, 'el reinicio no permite más POSTs');
  });

  console.log(`\n${passed} pasadas, ${results.filter((r) => r.startsWith('  ✗')).length} fallos`);
  for (const r of results) console.log(r);
}

main().catch((e) => { console.error('FATAL e2e:', e); process.exitCode = 1; }).finally(() => {
  killAll();
  setTimeout(() => {
    killAll();
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    process.exit(process.exitCode || 0);
  }, 400);
});
