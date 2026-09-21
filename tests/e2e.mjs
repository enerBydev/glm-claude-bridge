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
    assert.equal(r.version, 4);
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
