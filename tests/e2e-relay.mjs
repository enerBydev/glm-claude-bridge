#!/usr/bin/env node
// ============================================================================
// e2e-relay.mjs — QA E2E del transporte "Chat-Brain Relay" (v6) SIN upstream,
// SIN gateway y SIN cuota. El papel del cerebro (el LLM de la sesión de chat)
// lo simula el propio test escribiendo replies/<hash>.json en el spool.
//
//   node tests/e2e-relay.mjs   (exit 0 = todo OK)
//
// Escenarios:
//   1. fast-path hold       → respuesta durante el hold (JSON, end_turn, archive)
//   2. stream + tool_use    → SSE sintético completo (message_start…message_stop)
//   3. defer → 429 → hit    → hold expira, Retry-After, reintento idempotente
//   4. max-defers agotado   → 529 overloaded_error + pending a expired/
//   5. respuesta inválida   → rechazo con feedback (.error.txt) y autocorrección
//   6. digest + CLI         → instrucciones del digest + flujo pending/answer
// ============================================================================
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BRIDGE_PORT = 8805;
const B_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

let tmpDir = null;
let relayDir = null;
const procs = [];
let passed = 0;
const results = [];
let bridgeLog = '';

function killAll() {
  for (const { p } of procs) {
    try { p.kill('SIGTERM'); } catch {}
    try { p.kill('SIGKILL'); } catch {}
  }
}
process.on('exit', killAll);
process.on('uncaughtException', (e) => { console.error('FATAL:', e); killAll(); process.exit(1); });

async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ✓ ${name}`); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(`  ✗ ${name}: ${e.message}`); console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

function atomicWriteTmp(file, data) {
  const tmp = file + '.tmp-brain';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// --- "cerebro" simulado: publica una respuesta para un hash pendiente ---
function brainAnswer(hash, replyObj, delayMs = 0) {
  setTimeout(() => {
    try {
      atomicWriteTmp(path.join(relayDir, 'replies', hash + '.json'), JSON.stringify(replyObj));
    } catch (e) { console.error('brainAnswer fallo:', e.message); }
  }, delayMs);
}

const pendingHashes = () => fs.readdirSync(path.join(relayDir, 'pending'))
  .filter((f) => f.endsWith('.json') && !f.includes('.tmp'));
const replyHashes = () => fs.readdirSync(path.join(relayDir, 'replies'))
  .filter((f) => f.endsWith('.json') && !f.includes('.tmp'));

async function bridgePost(body) {
  return fetch(`${B_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sseEvents(rawText) {
  const evs = [];
  for (const block of rawText.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    if (!lines.length) continue;
    const ev = {};
    let dataStr;
    for (const l of lines) {
      if (l.startsWith('event:')) ev.event = l.slice(6).trim();
      if (l.startsWith('data:')) dataStr = l.slice(5).trim();
    }
    if (ev.event && dataStr) { try { ev.data = JSON.parse(dataStr); } catch {} evs.push(ev); }
  }
  return evs;
}

const baseBody = (over = {}) => ({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 128,
  stream: false,
  system: 'Eres un asistente de pruebas del relay.',
  messages: [{ role: 'user', content: 'Di hola' }],
  tools: [{
    name: 'Write',
    description: 'Escribe un fichero en disco',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] },
  }],
  ...over,
});

// lanza la petición y devuelve { hash, promise } del pending que aparece
async function launchAndHash(launch) {
  const promise = launch();
  for (let i = 0; i < 50; i++) {
    const files = pendingHashes();
    if (files.length) return { hash: files[files.length - 1].replace('.json', ''), promise };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no apareció pending en el spool');
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${B_URL}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('bridge relay no arrancó');
}

// ============================================================================
async function main() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-relay-e2e-'));
  relayDir = path.join(tmpDir, 'relay');

  const bridge = spawn(process.execPath, [path.join(ROOT, 'bridge.mjs')], {
    env: {
      ...process.env,
      GLM_BRIDGE_TRANSPORT: 'relay',
      GLM_BRIDGE_PORT: String(BRIDGE_PORT),
      GLM_BRIDGE_RELAY_DIR: relayDir,
      GLM_BRIDGE_RELAY_HOLD_MS: '1500',
      GLM_BRIDGE_RELAY_RETRY_AFTER_S: '1',
      GLM_BRIDGE_RELAY_MAX_DEFERS: '2',
      GLM_BRIDGE_RELAY_POLL_MS: '80',
      // sin config de sesión: el modo relay NO necesita credenciales
      ZAI_CONFIG_PATH: path.join(tmpDir, 'no-existe.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push({ name: 'bridge-relay', p: bridge });
  bridge.stdout.on('data', (d) => { bridgeLog += d; });
  bridge.stderr.on('data', (d) => { bridgeLog += d; });
  await waitHealthy();

  const health = await (await fetch(`${B_URL}/health`)).json();
  assert.equal(health.transport, 'relay', '/health declara transport=relay');
  assert.equal(health.status, 'ok', 'relay no requiere sesión: status ok');
  assert.equal(health.relay.dir, relayDir);
  assert.ok(health.relay_config.hold_ms > 0);

  // ------------------------------------------------------------------ 1
  await test('fast-path: respuesta durante el hold (JSON, end_turn, archive)', async () => {
    const { hash, promise } = await launchAndHash(() => bridgePost(baseBody()));
    brainAnswer(hash, { text: 'hola del cerebro del chat' });
    const res = await promise;
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.type, 'message');
    assert.match(j.id, /^msg_relay_/);
    assert.equal(j.content[0].type, 'text');
    assert.equal(j.content[0].text, 'hola del cerebro del chat');
    assert.equal(j.stop_reason, 'end_turn');
    assert.ok(j.usage.input_tokens > 0 && j.usage.output_tokens > 0);
    await new Promise((r) => setTimeout(r, 200));
    const arch = fs.readdirSync(path.join(relayDir, 'archive'));
    assert.ok(arch.includes(hash + '.reply.json'), 'reply archivada');
    assert.ok(arch.includes(hash + '.request.json'), 'request archivada');
    assert.equal(pendingHashes().length, 0, 'pending vacío tras responder');
  });

  // ------------------------------------------------------------------ 2
  await test('stream + tool_use: SSE sintético completo desde la respuesta del cerebro', async () => {
    const { hash, promise } = await launchAndHash(() => bridgePost(baseBody({
      stream: true,
      messages: [{ role: 'user', content: 'Crea /tmp/x.txt con hi' }],
    })));
    brainAnswer(hash, {
      text: 'Voy a crear el fichero.',
      tool_uses: [{ name: 'Write', input: { file_path: '/tmp/x.txt', content: 'hi' } }],
    });
    const res = await promise;
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const evs = sseEvents(await res.text());
    const kinds = evs.map((e) => e.event);
    assert.equal(kinds[0], 'message_start');
    const toolStart = evs.find((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
    assert.ok(toolStart, 'hay content_block_start de tool_use');
    assert.match(toolStart.data.content_block.id, /^toolu_relay_/);
    assert.equal(toolStart.data.content_block.name, 'Write');
    const delta = evs.find((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta');
    assert.equal(JSON.parse(delta.data.delta.partial_json).file_path, '/tmp/x.txt');
    const mDelta = evs.find((e) => e.event === 'message_delta');
    assert.equal(mDelta.data.delta.stop_reason, 'tool_use');
    assert.equal(kinds[kinds.length - 1], 'message_stop');
  });

  // ------------------------------------------------------------------ 3
  await test('defer: hold expira → 429+Retry-After → reintento idempotente encuentra la respuesta', async () => {
    const p1 = bridgePost(baseBody({ messages: [{ role: 'user', content: 'Tarea lenta' }] }));
    await new Promise((r) => setTimeout(r, 400));
    const hash = pendingHashes()[0].replace('.json', '');
    brainAnswer(hash, { text: 'tarea lenta completada' }, 2000); // > hold 1.5s
    const res1 = await p1;
    assert.equal(res1.status, 429, 'primer intento = 429 (defer)');
    assert.equal(res1.headers.get('retry-after'), '1');
    const err1 = await res1.json();
    assert.equal(err1.error.type, 'rate_limit_error');
    assert.match(err1.error.message, /cerebro del chat/);
    // CC reintenta con el MISMO body → mismo hash canónico → la encuentra
    const res2 = await bridgePost(baseBody({ messages: [{ role: 'user', content: 'Tarea lenta' }] }));
    assert.equal(res2.status, 200, 'reintento = 200');
    const j2 = await res2.json();
    assert.equal(j2.content[0].text, 'tarea lenta completada');
    await new Promise((r) => setTimeout(r, 200));
    const reqArch = JSON.parse(fs.readFileSync(path.join(relayDir, 'archive', hash + '.request.json'), 'utf-8'));
    assert.equal(reqArch.defer_count, 1, 'defer_count persistido en el envelope');
  });

  // ------------------------------------------------------------------ 4
  await test('max-defers agotado: 529 overloaded_error y pending a expired/', async () => {
    const body = baseBody({ messages: [{ role: 'user', content: 'Nadie me responde' }] });
    const res1 = await bridgePost(body);   // hold expira → defer 1 → 429
    assert.equal(res1.status, 429);
    const res2 = await bridgePost(body);   // defer 2 (== max) → 429
    assert.equal(res2.status, 429);
    const res3 = await bridgePost(body);   // defer_count 2 >= MAX_DEFERS → 529
    assert.equal(res3.status, 529);
    const err = await res3.json();
    assert.equal(err.error.type, 'overloaded_error');
    assert.match(err.error.message, /no respondió/);
    await new Promise((r) => setTimeout(r, 200));
    const exp = fs.readdirSync(path.join(relayDir, 'expired'));
    assert.ok(exp.some((f) => f.endsWith('.request.json')), 'request movida a expired/');
  });

  // ------------------------------------------------------------------ 5
  await test('respuesta inválida: rechazo con .error.txt y autocorrección dentro del hold', async () => {
    const { hash, promise } = await launchAndHash(() => bridgePost(baseBody({ messages: [{ role: 'user', content: 'Con formato roto' }] })));
    // observador en vuelo: el error.txt de feedback debe existir MIENTRAS espera
    const sawErrorTxt = (async () => {
      for (let i = 0; i < 60; i++) {
        if (fs.existsSync(path.join(relayDir, 'replies', hash + '.error.txt'))) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    })();
    brainAnswer(hash, { nonsense: true }, 100);             // inválida → rechazada
    brainAnswer(hash, { text: 'ahora sí, corregida' }, 600); // corregida dentro del hold
    const res = await promise;
    assert.equal(res.status, 200, 'la corrección dentro del hold salva la petición');
    const j = await res.json();
    assert.equal(j.content[0].text, 'ahora sí, corregida');
    assert.ok(await sawErrorTxt, '.error.txt con feedback apareció durante el vuelo');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(replyHashes().some((f) => f.includes('.rejected-')), 'la inválida quedó apartada');
    assert.ok(!fs.existsSync(path.join(relayDir, 'replies', hash + '.error.txt')), 'error.txt limpiado al archivar con éxito');
  });

  // ------------------------------------------------------------------ 6
  await test('digest + CLI: instrucciones, tools, pending y answer manual', async () => {
    const archDigest = fs.readdirSync(path.join(relayDir, 'archive')).find((f) => f.endsWith('.digest.md'));
    assert.ok(archDigest, 'digest archivado');
    const dtext = fs.readFileSync(path.join(relayDir, 'archive', archDigest), 'utf-8');
    assert.match(dtext, /CEREBRO DEL CHAT/);
    assert.match(dtext, /## tools \(1\)/);
    assert.match(dtext, /- Write\(file_path, content\)/);

    const { hash, promise } = await launchAndHash(() => bridgePost(baseBody({ messages: [{ role: 'user', content: 'Respondida por CLI' }] })));
    await new Promise((r) => setTimeout(r, 100));
    const pendOut = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'relay.mjs'), 'pending'], {
        env: { ...process.env, GLM_BRIDGE_RELAY_DIR: relayDir },
      });
      let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; });
      c.on('exit', () => resolve(o));
    });
    assert.match(pendOut, /Respondida por CLI/, 'CLI pending lista la petición');
    const replyFile = path.join(tmpDir, 'manual-reply.json');
    fs.writeFileSync(replyFile, JSON.stringify({ text: 'publicada por glm-bridge relay-answer' }));
    const ansOut = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'relay.mjs'), 'answer', hash, replyFile], {
        env: { ...process.env, GLM_BRIDGE_RELAY_DIR: relayDir },
      });
      let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; });
      c.on('exit', () => resolve(o));
    });
    assert.match(ansOut, /OK/);
    const res = await promise;
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.content[0].text, 'publicada por glm-bridge relay-answer');
  });
}

main().then(() => {
  console.log(`\ne2e-relay: ${passed} escenario(s) OK`);
  if (process.exitCode) console.error(results.join('\n') + '\n--- log bridge ---\n' + bridgeLog);
  process.exit(process.exitCode || 0);
}).catch((e) => { console.error('FATAL runner:', e); console.error('--- log bridge ---\n' + bridgeLog); killAll(); process.exit(1); });
