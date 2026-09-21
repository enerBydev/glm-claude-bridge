#!/usr/bin/env node
// diag-ultra.mjs — diagnóstico del escenario ultra: vuelca lo que el mock vio
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MOCK = 8795, BRIDGE = 8796;
const B_URL = `http://127.0.0.1:${BRIDGE}`, M_URL = `http://127.0.0.1:${MOCK}`;
const procs = [];
const tmpDirs = [];
const killAll = () => { for (const { p } of procs) { try { p.kill('SIGKILL'); } catch {} } };
process.on('exit', killAll);
const mkTmp = (pfx) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), pfx)); tmpDirs.push(d); return d; };
const waitHttp = async (url, n = 60) => { for (let i = 0; i < n; i++) { try { const r = await fetch(url); if (r.ok || r.status === 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; };

const cfgDir = mkTmp('diag-cfg-');
fs.writeFileSync(path.join(cfgDir, '.z-ai-config'), JSON.stringify({ baseUrl: `${M_URL}/v1`, apiKey: 'Z.ai', token: 'JWT-DIAG', chatId: 'chat-diag', userId: 'user-diag' }));
const cc = mkTmp('diag-cc-');
fs.writeFileSync(path.join(cc, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }));
fs.writeFileSync(path.join(cc, 'settings.json'), JSON.stringify({ permissions: { allow: ['Task', 'Bash', 'Read', 'Glob', 'Grep'] } }));
const cwd = mkTmp('diag-cwd-');

const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: B_URL, ANTHROPIC_AUTH_TOKEN: 'glm-bridge-local', ANTHROPIC_API_KEY: '',
  ANTHROPIC_MODEL: 'claude-opus-5',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-opus-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-opus-5',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5', ANTHROPIC_SMALL_FAST_MODEL: 'claude-opus-5',
  CLAUDE_CODE_EFFORT_LEVEL: 'ultracode',
  CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1', MAX_THINKING_TOKENS: '0', API_TIMEOUT_MS: '120000', CLAUDE_CONFIG_DIR: cc,
};
const PROMPT = 'MOCK:TASK Lanza un subagente con la herramienta Task que responda exactamente MOCK-SUBAGENT-OK. Espera su resultado y repórtalo literal. ultracode';

procs.push({ p: spawn(process.execPath, ['/home/z/my-project/tests/mock-upstream.mjs'], { env: { ...process.env, MOCK_PORT: String(MOCK) } }) });
procs.push({ p: spawn(process.execPath, ['/home/z/my-project/bridge.mjs', '--glm-diag'], { env: { ...process.env, GLM_BRIDGE_PORT: String(BRIDGE), ZAI_CONFIG_PATH: path.join(cfgDir, '.z-ai-config'), GLM_BRIDGE_MIN_INTERVAL_MS: '0', GLM_MODEL: 'glm-5.3-flash' } }) });
if (!await waitHttp(`${B_URL}/health`) || !await waitHttp(`${M_URL}/__mock/requests`)) { console.error('no arrancó'); process.exit(1); }

const child = spawn(process.env.CLAUDE_BIN || `${os.homedir()}/.npm-global/bin/claude`,
  ['-p', PROMPT, '--dangerously-skip-permissions', '--output-format', 'text', '--max-turns', '8'],
  { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
let so = '', se = '';
child.stdout.on('data', (d) => { so += d; });
child.stderr.on('data', (d) => { se += d; });
const code = await new Promise((r) => child.on('exit', r) || child.on('error', r));
console.log(`claude exit=${code}\n── stdout (cola) ──\n${so.slice(-500)}\n── stderr (cola) ──\n${se.slice(-300)}`);

const caps = (await (await fetch(`${M_URL}/__mock/requests`)).json()).requests.filter((c) => (c.url || '').includes('/chat/completions'));
console.log(`\n${caps.length} llamadas upstream:`);
caps.forEach((c, i) => {
  const tools = (c.body?.tools || []).map((t) => t?.function?.name || t?.name).filter(Boolean);
  console.log(`\n#${i} model=${c.body?.model} stream=${c.body?.stream} thinking=${JSON.stringify(c.body?.thinking)} nmsgs=${msgs_len(c)} tools(${tools.length})=${tools.join(',')}`);
  const msgs = (c.body?.messages || []).map((m) => `${m.role}:${String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).replace(/\s+/g, ' ').slice(0, 90)}`);
  console.log('   ' + msgs.slice(-4).join('\n   '));
});
function msgs_len(c) { return (c.body?.messages || []).length; }
for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
process.exit(0);
