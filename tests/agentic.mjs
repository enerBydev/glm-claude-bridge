#!/usr/bin/env node
// ============================================================================
// agentic.mjs — TEST AGÉNTICO REAL: Claude Code oficial ↔ bridge ↔ mock GLM.
//
// Es el test de máximo nivel del QA: demuestra que Claude Code instalado en
// la sesión funciona de punta a punta SIN gateway real y SIN gastar cuota:
//
//   claude -p "MOCK:TOOL ..."                    (binario real de Claude Code)
//     → ANTHROPIC_BASE_URL = bridge de prueba    (puerto 8794)
//       → translate Anthropic→OpenAI             (bridge.mjs real)
//         → mock GLM                             (puerto 8793, MOCK:TOOL)
//           ← tool_calls Bash{echo mock-tool-ok} (SSE, input_json_delta)
//       ← translate OpenAI→Anthropic (tool_use)  (bridge.mjs real)
//     ← Claude Code EJECUTA la herramienta       (permisos saltados)
//       → tool_result → bridge → mock            (role:'tool' tras traducir)
//         ← "AGENTIC-LOOP-OK <salida>"           (cierre determinista)
//     ← Claude Code imprime el resultado final   (stdout del test)
//
// Afirmaciones: salida contiene AGENTIC-LOOP-OK y mock-tool-ok; el mock vio
// ≥2 llamadas con cabeceras de sesión (X-Token), toolset de CC (≥5 tools) y
// un mensaje role:'tool' (ida y vuelta de herramientas por el bridge).
//
// Si Claude Code no está instalado: SKIP (exit 0) salvo GLM_AGENTIC_REQUIRE=1.
// Puertos configurables: GLM_AGENTIC_MOCK_PORT (8793) / GLM_AGENTIC_BRIDGE_PORT (8794).
//   node tests/agentic.mjs    (exit 0 = todo OK)
// ============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MOCK = Number(process.env.GLM_AGENTIC_MOCK_PORT || 8793);
const BRIDGE = Number(process.env.GLM_AGENTIC_BRIDGE_PORT || 8794);
const B_URL = `http://127.0.0.1:${BRIDGE}`;
const M_URL = `http://127.0.0.1:${MOCK}`;
const CLAUDE_TIMEOUT_MS = Number(process.env.GLM_AGENTIC_TIMEOUT_MS || 150000);
const MODEL = 'glm-5.3-flash';
const PROMPT = 'MOCK:TOOL Usa la herramienta Bash para ejecutar: echo mock-tool-ok. Después informa la salida literal tal cual.';
const PROMPT_ULTRA = 'MOCK:TASK Lanza un subagente con la herramienta Task que responda exactamente MOCK-SUBAGENT-OK. Espera su resultado y repórtalo literal. ultracode';

const procs = [];
const tmpDirs = [];
let passed = 0;
const results = [];

function killAll() {
  for (const { p } of procs) {
    try { p.kill('SIGTERM'); } catch {}
    try { p.kill('SIGKILL'); } catch {}
  }
}
process.on('exit', killAll);
process.on('uncaughtException', (e) => { console.error('FATAL:', e); killAll(); process.exit(1); });

function startProc(name, cmd, args, env) {
  const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push({ name, p });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (code) => { if (code && code !== 0 && name !== 'claude') console.error(`[${name}] exit ${code}\n${out.slice(-800)}`); });
  return p;
}

async function waitHttp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status === 500) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function resolveClaude() {
  const cands = [];
  if (process.env.CLAUDE_BIN) cands.push(process.env.CLAUDE_BIN);
  for (const d of (process.env.PATH || '').split(':')) {
    if (d) cands.push(path.join(d, 'claude'));
  }
  cands.push(
    path.join(os.homedir(), '.npm-global/bin/claude'),
    path.join(os.homedir(), '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    path.join(os.homedir(), '.claude/local/claude'),
  );
  for (const p of cands) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

async function mockCapture() {
  const r = await fetch(`${M_URL}/__mock/requests`);
  return (await r.json()).requests;
}

async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ✓ ${name}`); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(`  ✗ ${name}: ${e.message}`); console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

async function runClaude(bin, opts = {}) {
  const prompt = opts.prompt || PROMPT;
  const model = opts.model || MODEL;
  // aislamiento total: config propia (onboarding ya hecho) + cwd propio
  const ccConfig = mkTmp('glm-agentic-cc-');
  const ccCwd = mkTmp('glm-agentic-cwd-');
  fs.writeFileSync(path.join(ccConfig, '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }));
  // permisoso por settings (doble seguro junto a --dangerously-skip-permissions)
  fs.writeFileSync(path.join(ccConfig, 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash', 'Read', 'Write', 'Glob', 'Grep'] } }));

  // mismo juego de variables que glm-claude, apuntando al bridge de PRUEBA
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: B_URL,
    ANTHROPIC_AUTH_TOKEN: 'glm-bridge-local',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    MAX_THINKING_TOKENS: '0',
    API_TIMEOUT_MS: '120000',
    CLAUDE_CONFIG_DIR: ccConfig,
  };
  if (opts.effort) env.CLAUDE_CODE_EFFORT_LEVEL = opts.effort;

  return new Promise((resolve) => {
    const child = spawn(bin, ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text', '--max-turns', '8'],
      { cwd: ccCwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push({ name: 'claude', p: child });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ code: -1, stdout, stderr: stderr + `\n[glm-agentic] TIMEOUT ${CLAUDE_TIMEOUT_MS}ms` });
    }, CLAUDE_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -2, stdout, stderr: String(e) }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// ============================================================================
async function main() {
  // pre-limpieza defensiva de restos en NUESTROS puertos
  try { spawn('pkill', ['-f', 'tests/mock-upstream.mjs']); } catch {}
  try { spawn('pkill', ['-f', 'bridge.mjs --glm-agentic']); } catch {}
  await new Promise((r) => setTimeout(r, 300));

  const bin = resolveClaude();
  if (!bin) {
    const msg = 'Claude Code no está instalado — test agéntico OMITIDO (instálalo con install.sh --with-claude)';
    if (process.env.GLM_AGENTIC_REQUIRE === '1') { console.error(`FATAL: ${msg}`); process.exitCode = 1; return; }
    console.log(`SKIP: ${msg}`);
    return;
  }

  console.log(`Test agéntico: Claude Code ${bin} ↔ bridge:${BRIDGE} ↔ mock:${MOCK} (cero cuota)\n`);

  // credenciales de sesión temporales → el bridge DE PRUEBA nace contra el mock
  const cfgDir = mkTmp('glm-agentic-cfg-');
  fs.writeFileSync(path.join(cfgDir, '.z-ai-config'), JSON.stringify({
    baseUrl: `${M_URL}/v1`, apiKey: 'Z.ai',
    token: 'JWT-AGENTIC', chatId: 'chat-agentic-1', userId: 'user-agentic',
  }));

  startProc('mock', process.execPath, [path.join(__dirname, 'mock-upstream.mjs')],
    { MOCK_PORT: String(MOCK) });
  startProc('bridge', process.execPath, [path.join(ROOT, 'bridge.mjs'), '--glm-agentic'], {
    GLM_BRIDGE_PORT: String(BRIDGE),
    ZAI_CONFIG_PATH: path.join(cfgDir, '.z-ai-config'),
    GLM_BRIDGE_MIN_INTERVAL_MS: '0',
    GLM_BRIDGE_RETRIES: '2',
    GLM_BRIDGE_RETRY_BASE_MS: '50',
    GLM_MODEL: MODEL,
  });
  if (!await waitHttp(`${B_URL}/health`)) throw new Error('bridge de prueba no arrancó');
  if (!await waitHttp(`${M_URL}/__mock/requests`)) throw new Error('mock no arrancó');

  // 1 ── health del bridge de prueba -----------------------------------------
  await test('health del bridge de prueba: ok, v4, sesión agéntica visible', async () => {
    const h = await (await fetch(`${B_URL}/health`)).json();
    if (h.status !== 'ok') throw new Error(`status=${h.status}`);
    if (h.version !== 5) throw new Error(`version=${h.version}`);
    // el health expone la HUELLA del token (últimos 8 chars), nunca el token
    if (!String(h.session?.token || '').includes('AGENTIC')) throw new Error(`sesión no visible: ${h.session?.token}`);
  });

  // 2 ── LA PRUEBA AGÉNTICA REAL ---------------------------------------------
  let run = null;
  await test('claude -p completa el bucle agéntico (tool_use→ejecución→tool_result→texto final)', async () => {
    run = await runClaude(bin);
    if (run.code !== 0) {
      throw new Error(`claude exit=${run.code} | stderr: ${(run.stderr || '').slice(-400).replace(/\n/g, ' ⏎ ')}`);
    }
    if (!run.stdout.includes('AGENTIC-LOOP-OK')) {
      throw new Error(`sin AGENTIC-LOOP-OK en stdout: "${run.stdout.slice(-300)}"`);
    }
    if (!run.stdout.includes('mock-tool-ok')) {
      throw new Error(`sin mock-tool-ok en stdout: "${run.stdout.slice(-300)}"`);
    }
  });

  // 3 ── evidencia en el mock: qué vio el "gateway" ---------------------------
  await test('mock visto por CC: ≥2 llamadas con X-Token de sesión y toolset de CC', async () => {
    const caps = (await mockCapture()).filter((c) => (c.url || '').includes('/chat/completions'));
    if (caps.length < 2) throw new Error(`solo ${caps.length} llamadas upstream`);
    const first = caps[0];
    if (first.headers['x-token'] !== 'JWT-AGENTIC') throw new Error(`X-Token incorrecto: ${first.headers['x-token']}`);
    if (first.headers['x-chat-id'] !== 'chat-agentic-1') throw new Error('X-Chat-Id incorrecto');
    const nTools = Array.isArray(first.body?.tools) ? first.body.tools.length : 0;
    if (nTools < 5) throw new Error(`toolset de CC no llegó (${nTools} tools en la 1ª llamada)`);
    if (first.body?.model !== MODEL) throw new Error(`model=${first.body?.model}`);
  });

  // 4 ── ida y vuelta de herramientas por el bridge ---------------------------
  await test('tool_result cruzó el bridge: el mock recibió role:tool con la salida', async () => {
    const caps = (await mockCapture()).filter((c) => (c.url || '').includes('/chat/completions'));
    const withToolMsg = caps.filter((c) => Array.isArray(c.body?.messages) && c.body.messages.some((m) => m?.role === 'tool'));
    if (!withToolMsg.length) throw new Error('ninguna llamada contenía role:tool');
    const joined = JSON.stringify(withToolMsg[withToolMsg.length - 1].body);
    if (!joined.includes('mock-tool-ok')) throw new Error('la salida del comando no llegó al mock');
  });

  // 5 ── ULTRA: fachada claude-opus-5 + effort ultracode (workflow Task) ─────
  await fetch(`${M_URL}/__mock/reset`, { method: 'POST' }).catch(() => {});
  let runUltra = null;
  await test('ultra: CC ve claude-opus-5 + effort ultracode y completa Task→subagente→texto', async () => {
    runUltra = await runClaude(bin, { model: 'claude-opus-5', effort: 'ultracode', prompt: PROMPT_ULTRA });
    if (runUltra.code !== 0) {
      throw new Error(`claude exit=${runUltra.code} | stderr: ${(runUltra.stderr || '').slice(-400).replace(/\n/g, ' ⏎ ')}`);
    }
    if (!runUltra.stdout.includes('AGENTIC-LOOP-OK')) {
      throw new Error(`sin AGENTIC-LOOP-OK: "${runUltra.stdout.slice(-300)}"`);
    }
    if (/unrecognized_model/.test(runUltra.stderr)) {
      throw new Error('CC no reconoció claude-opus-5 (fachada rota)');
    }
  });

  // 6 ── ULTRA: sin fuga de fachada + subagente de vuelta por el bridge ──────
  await test('ultra: upstream SIEMPRE glm-5.3-flash (sin fuga) y salida del subagente de vuelta', async () => {
    const caps = (await mockCapture()).filter((c) => (c.url || '').includes('/chat/completions'));
    if (caps.length < 2) throw new Error(`solo ${caps.length} llamadas upstream`);
    const leaked = caps.filter((c) => c.body?.model !== 'glm-5.3-flash');
    if (leaked.length) throw new Error(`fuga de fachada: ${leaked[0].body?.model}`);
    const subOut = caps.filter((c) => Array.isArray(c.body?.messages)
      && c.body.messages.some((m) => m?.role === 'tool' && JSON.stringify(m.content || '').includes('MOCK-SUBAGENT-OK')));
    if (!subOut.length) throw new Error('la salida del subagente (Task) no regresó por el bridge');
  });

  console.log(`\nAGENTIC: ${passed} pasadas, ${results.filter((r) => r.startsWith('  ✗')).length} fallos`);
  for (const r of results) console.log(r);
  if (process.env.GLM_AGENTIC_DEBUG === '1' && run) {
    console.log('\n--- stdout de claude (cola) ---\n' + run.stdout.slice(-600));
    console.log('\n--- stderr de claude (cola) ---\n' + (run.stderr || '').slice(-600));
  }
}

main()
  .catch((e) => { console.error('FATAL agentic:', e); process.exitCode = 1; })
  .finally(() => {
    killAll();
    setTimeout(() => {
      killAll();
      for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
      process.exit(process.exitCode || 0);
    }, 400);
  });
