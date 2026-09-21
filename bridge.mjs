#!/usr/bin/env node
// ============================================================================
// bridge.mjs — GLM-Bridge v4 (portable, session-born)
// Servidor local que expone la API de Messages de Anthropic y la traduce a
// GLM (endpoint OpenAI-compat) usando EL MISMO MECANISMO DE NACIMIENTO de la
// sesión: /etc/.z-ai-config con el JWT de sesión (X-Token) + identidad del
// chat (X-Chat-Id/X-User-Id) que el runtime de la plataforma inyecta.
// Sin dependencias externas.
//
//   Claude Code  ──HTTP/SSE──▶  GLM-Bridge  ──HTTP/SSE──▶  internal-api.z.ai
//   (oficial)     /v1/messages   este proceso            /chat/completions
//                                            (X-Token JWT de ESTA sesión)
//
// v3: credenciales con recarga automática por mtime (la plataforma re-inyecta
// el token en cada continuación de conversación; sin X-Token el gateway
// responde 401), thinking bajo demanda (request de CC o GLM_THINKING),
// reasoning_content → bloques thinking Anthropic, y logging de cuota.
// v4 (portable): CERO valores congelados — upstream (baseUrl) y modelo se
// resuelven POR PETICIÓN desde el proveedor de configuración; así, si el
// runtime de la plataforma cambia baseUrl, token, chatId o modelo en
// /etc/.z-ai-config, el bridge se adapta sin reiniciar ni reconfigurar nada.
// Instalable en cualquier sesión de chat.z.ai con ./install.sh.
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadZaiConfig, createConfigProvider, tokenFingerprint, upstreamHeaders, upstreamUrl, upstreamVisionUrl } from './zai-config.mjs';
import {
  buildUpstreamRequest,
  anthropicFromComplete,
  estimateTokens,
} from './translate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const PORT = Number(process.env.GLM_BRIDGE_PORT || 8787);
const HOST = process.env.GLM_BRIDGE_HOST || '127.0.0.1';
const DEFAULT_MODEL = process.env.GLM_MODEL || 'glm-5.3-flash';
const THINKING = process.env.GLM_THINKING === '1';
const TOOL_HINT = process.env.GLM_BRIDGE_TOOL_HINT !== '0';
const MAX_RETRIES = Number(process.env.GLM_BRIDGE_RETRIES || 4);
const RETRY_BASE_MS = Number(process.env.GLM_BRIDGE_RETRY_BASE_MS || 900);
const BRIDGE_TOKEN = process.env.GLM_BRIDGE_TOKEN || ''; // opcional
const IDLE_TIMEOUT_MS = Number(process.env.GLM_BRIDGE_IDLE_MS || 60000);
// El WAF del gateway hace blackhole silencioso ante ráfagas (herramientas
// locales instantáneas => peticiones separadas por <30ms). Espacio mínimo
// entre INICIOS de peticiones upstream.
const MIN_INTERVAL_MS = Number(process.env.GLM_BRIDGE_MIN_INTERVAL_MS || 3000);
let lastUpstreamStart = 0;
// Cookie jar anti-WAF: el WAF (Alibaba) emite acw_tc y penaliza con blackhole
// de 300s a los clientes que no lo reenvían (cada request parece "nuevo").
const cookieJar = new Map();
// v3: proveedor de credenciales con recarga automática (mtime). La plataforma
// re-inyecta el JWT de sesión en /etc/.z-ai-config; una copia estática muere
// en cuanto el token rota (causa raíz del 401 "missing X-Token header").
const getConfig = createConfigProvider();
function headersWithCookies() {
  const cfg = getConfig();
  if (cfg._reloaded) {
    cfg._reloaded = false;
    log(`sesión: credenciales RECARGADAS (token ${tokenFingerprint(cfg.token)}, chatId=${cfg.chatId || 'sin'})`);
  }
  const base = upstreamHeaders(cfg);
  if (!cookieJar.size) return base;
  const cookie = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return { ...base, Cookie: cookie };
}
function absorbCookies(res) {
  try {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  } catch { /* getSetCookie no disponible */ }
}
const LOG_DIR = path.join(__dirname, 'logs');

// v4: el upstream YA NO se congela al arrancar — se resuelve por petición
// desde getConfig() (si la plataforma cambia baseUrl, el bridge se adapta).
function upstreamOf(cfg) { return upstreamUrl(cfg); }
function upstreamVisionOf(cfg) { return upstreamVisionUrl(cfg); }

// v4: resolución dinámica del modelo por petición:
//   1. GLM_MODEL (env, lo fija glm-claude --model)
//   2. cfg.model (campo opcional "model" en el fichero de sesión z-ai-config)
//   3. 'glm-5.3-flash' (fallback portable)
function resolveModel(cfg) {
  return process.env.GLM_MODEL || cfg.model || DEFAULT_MODEL;
}

// último "model" que el gateway declaró servir en su eco (puede ser cosmético)
let lastEchoModel = null;
// última cuota observada (buckets key-level y user-level)
let lastQuota = null;

fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `bridge-${new Date().toISOString().slice(0, 10)}.log`);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(line) {
  const ts = new Date().toISOString();
  const full = `[${ts}] ${line}`;
  process.stdout.write(full + '\n');
  fs.appendFile(LOG_FILE, full + '\n', () => {});
}

// ---------------------------------------------------------------------------
// Errores estilo Anthropic
// ---------------------------------------------------------------------------
function anthropicError(res, status, type, message) {
  const body = JSON.stringify({ type: 'error', error: { type, message } });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function mapUpstreamStatus(code) {
  if (code === 401 || code === 403) return { status: 401, type: 'authentication_error' };
  if (code === 429) return { status: 429, type: 'rate_limit_error' };
  if (code === 503 || code === 529) return { status: 529, type: 'overloaded_error' };
  return { status: 502, type: 'api_error' };
}

// ---------------------------------------------------------------------------
// Request body reader
// ---------------------------------------------------------------------------
function readBody(req, limit = 256 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Upstream con reintentos (backoff exponencial + jitter)
// ---------------------------------------------------------------------------
const RETRYABLE = new Set([403, 429, 500, 502, 503, 504]);

async function fetchUpstream(bodyObj, reqLog, targetUrl) {
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = RETRY_BASE_MS * 2 ** (attempt - 1) + Math.random() * 250;
      reqLog(`reintento ${attempt}/${MAX_RETRIES} en ${Math.round(wait)}ms (causa: ${lastErr?.kind}${lastErr?.status ? ' ' + lastErr.status : ''})`);
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: headersWithCookies(),
        body: JSON.stringify(bodyObj),
      });
      absorbCookies(res);
      if (!res.ok && RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
        // FAIL-FAST en agotamiento diario: si algún bucket daily está a 0,
        // reintentar sólo quema cuota user (cada 429 la descuenta).
        if (res.status === 429) {
          const q = quotaOf(res);
          if (q.keyDailyRemaining === 0 || q.userDailyRemaining === 0) {
            reqLog(`429 con daily agotado (key=${q.keyDailyRemaining} user=${q.userDailyRemaining}): fail-fast, sin reintentos`);
            lastErr = { kind: 'http', status: 429, txt: 'daily agotado' };
            break;
          }
        }
        const txt = await res.text().catch(() => '');
        lastErr = { kind: 'http', status: res.status, txt };
        continue;
      }
      return res;
    } catch (e) {
      lastErr = { kind: 'network', status: 0, txt: String(e?.cause?.code || e?.message || e) };
      if (attempt >= MAX_RETRIES) throw Object.assign(new Error(`upstream inaccesible: ${lastErr.txt}`), { upstream: true });
    }
  }
  // sólo alcanzable si el último intento fue retryable sin éxito
  const e = new Error(`upstream agotó reintentos: ${lastErr?.status || ''} ${lastErr?.txt || ''}`.trim());
  e.status = lastErr?.status;
  throw e;
}

// ---------------------------------------------------------------------------
// SSE del upstream: parser línea a línea
// ---------------------------------------------------------------------------
function sseLineParser(onData) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) onData(payload);
      }
      // líneas 'event:', comentarios ':' etc. del upstream se ignoran
    }
    // conservar resto parcial en buf
  };
}

// ---------------------------------------------------------------------------
// Manejador de /v1/messages
// ---------------------------------------------------------------------------
async function handleMessages(req, res) {
  const t0 = Date.now();

  // auth opcional del bridge
  if (BRIDGE_TOKEN) {
    const auth = req.headers['authorization'] || req.headers['x-api-key'] || '';
    if (!String(auth).includes(BRIDGE_TOKEN)) {
      return anthropicError(res, 401, 'authentication_error', 'token de bridge inválido');
    }
  }

  let anthropicBody;
  try {
    const raw = await readBody(req);
    anthropicBody = JSON.parse(raw.toString('utf-8') || '{}');
  } catch (e) {
    return anthropicError(res, 400, 'invalid_request_error', 'JSON inválido: ' + e.message);
  }

  // v4: modelo resuelto dinámicamente (env > fichero de sesión > fallback)
  const sessionModel = resolveModel(getConfig());
  const requestedModel = anthropicBody.model || sessionModel;
  // cualquier modelo no-GLM se dirige al modelo por defecto del bridge
  const upstreamModel = /^glm/i.test(requestedModel) ? requestedModel : sessionModel;

  const offeredNames = new Set(
    (Array.isArray(anthropicBody.tools) ? anthropicBody.tools : [])
      .map((t) => t?.name).filter(Boolean)
  );

  // thinking: default del entorno (GLM_THINKING) con override por petición —
  // si CC pide thinking:{type:'enabled'} se honra nativamente.
  const requestThinking = anthropicBody.thinking?.type === 'enabled';
  const effectiveThinking = THINKING || requestThinking;

  // ojo: en Node 24 los chunks de fetch.body son Uint8Array (no Buffer):
  // .toString() daría los códigos de byte unidos por comas. Usar TextDecoder.
  const decoder = new TextDecoder('utf-8');

  const upstreamBody = buildUpstreamRequest(anthropicBody, {
    model: upstreamModel,
    thinking: effectiveThinking,
    toolHint: TOOL_HINT,
  });
  // ANTI-WAF: el gateway/WAF deja en cola y vacía a los 300s las peticiones
  // SSE (stream:true) bajo carga; las stream:false pasan siempre. Pedimos
  // SIEMPRE no-stream y sintetizamos los eventos Anthropic localmente.
  if (process.env.GLM_BRIDGE_UPSTREAM_STREAM !== '1') upstreamBody.stream = false;
  // Algunos backends GLM rechazan/encolan max_tokens grandes (32768 de CC);
  // cap configurable (GLM_BRIDGE_MAX_OUT) — CC lo usa como tope, no como meta.
  const MAX_OUT = Number(process.env.GLM_BRIDGE_MAX_OUT || 0);
  if (MAX_OUT > 0) upstreamBody.max_tokens = Math.min(upstreamBody.max_tokens, MAX_OUT);

  // routing de visión: el gateway sólo acepta imágenes en /chat/completions/vision
  // v4: upstream resuelto AHORA (por petición) desde la config viva de la sesión
  const cfgNow = getConfig();
  const hasImages = (anthropicBody.messages || []).some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b && b.type === 'image')
  );
  const targetUrl = hasImages ? upstreamVisionOf(cfgNow) : upstreamOf(cfgNow);

  const shortId = Math.random().toString(36).slice(2, 8);
  const reqLog = (m) => log(`req ${shortId} | ${m}`);
  if (hasImages) reqLog(`routing: petición con imágenes -> ${targetUrl}`);
  reqLog(`${req.method} ${req.url} | modelo_up=${upstreamModel} | stream=${!!anthropicBody.stream} | thinking=${effectiveThinking ? 'on' : 'off'}${requestThinking && !THINKING ? '(req)' : ''} | msgs=${anthropicBody.messages?.length || 0} | tools=${offeredNames.size}`);

  // throttle anti-WAF: separar inicios de peticiones upstream
  if (MIN_INTERVAL_MS > 0) {
    const now = Date.now();
    const wait = lastUpstreamStart + MIN_INTERVAL_MS - now;
    if (wait > 0) {
      reqLog(`throttle: esperando ${wait}ms (intervalo mínimo ${MIN_INTERVAL_MS}ms)`);
      await new Promise((r) => setTimeout(r, wait));
    }
    lastUpstreamStart = Date.now();
  }

  let upRes;
  try {
    upRes = await fetchUpstream(upstreamBody, reqLog, targetUrl);
  } catch (e) {
    reqLog(`ERROR upstream: ${e.message}`);
    const mapped = e.status ? mapUpstreamStatus(e.status) : { status: 502, type: 'api_error' };
    return anthropicError(res, mapped.status, mapped.type, `GLM-Bridge: ${e.message}`);
  }

  if (!upRes.ok) {
    const txt = await upRes.text().catch(() => '');
    reqLog(`upstream ${upRes.status}: ${txt.slice(0, 300)}`);
    if (upRes.status === 429) {
      const q = quotaOf(upRes);
      reqLog(`429 buckets: key_daily=${q.keyDailyRemaining} user_10min=${q.user10minRemaining}/${q.user10minLimit} user_daily=${q.userDailyRemaining}`);
    }
    const mapped = mapUpstreamStatus(upRes.status);
    return anthropicError(res, mapped.status, mapped.type, `upstream GLM ${upRes.status}: ${txt.slice(0, 300)}`);
  }

  let upJson;
  try { upJson = JSON.parse(await upRes.text()); }
  catch (e) { return anthropicError(res, 502, 'api_error', 'respuesta upstream no-JSON: ' + e.message); }
  if (upJson.model) { lastEchoModel = upJson.model; reqLog(`eco gateway model=${upJson.model}`); }
  lastQuota = quotaOf(upRes);
  const final = anthropicFromComplete(upJson, requestedModel, offeredNames);
  const reasoningLen = final.content.filter((b) => b.type === 'thinking').reduce((a, b) => a + (b.thinking || '').length, 0);

  // ---------- No streaming ----------
  if (!anthropicBody.stream) {
    return sendJson(res, 200, final, reqLog, t0, { stats: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens, tools: final.content.filter(b => b.type === 'tool_use').length, reasoning: reasoningLen } });
  }

  // ---------- Streaming sintético (SSE Anthropic desde respuesta completa) ----------
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const writeEvent = ({ event, data }) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  writeEvent({ event: 'message_start', data: {
    type: 'message_start',
    message: {
      id: final.id, type: 'message', role: 'assistant', model: final.model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: final.usage.input_tokens, output_tokens: 1 },
    },
  } });
  writeEvent({ event: 'ping', data: { type: 'ping' } });
  final.content.forEach((block, idx) => {
    if (block.type === 'text') {
      writeEvent({ event: 'content_block_start', data: { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } } });
      writeEvent({ event: 'content_block_delta', data: { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: block.text } } });
      writeEvent({ event: 'content_block_stop', data: { type: 'content_block_stop', index: idx } });
    } else if (block.type === 'thinking') {
      writeEvent({ event: 'content_block_start', data: { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } } });
      writeEvent({ event: 'content_block_delta', data: { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: block.thinking } } });
      writeEvent({ event: 'content_block_delta', data: { type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: block.signature || '' } } });
      writeEvent({ event: 'content_block_stop', data: { type: 'content_block_stop', index: idx } });
    } else if (block.type === 'tool_use') {
      writeEvent({ event: 'content_block_start', data: { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } } });
      writeEvent({ event: 'content_block_delta', data: { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } } });
      writeEvent({ event: 'content_block_stop', data: { type: 'content_block_stop', index: idx } });
    }
  });
  writeEvent({ event: 'message_delta', data: {
    type: 'message_delta',
    delta: { stop_reason: final.stop_reason, stop_sequence: null },
    usage: { output_tokens: final.usage.output_tokens },
  } });
  writeEvent({ event: 'message_stop', data: { type: 'message_stop' } });
  try { res.end(); } catch {}
  log(`req ${shortId} | OK synth-stream | ${Date.now() - t0}ms | in=${final.usage.input_tokens} out=${final.usage.output_tokens} tools=${final.content.filter(b => b.type === 'tool_use').length} reasoning=${reasoningLen} chars=${final.content.filter(b => b.type === 'text').reduce((a, b) => a + (b.text || '').length, 0)}`);
}

/** Extrae los contadores de cuota de una respuesta upstream. */
function quotaOf(res) {
  const g = (n) => res.headers.get(n);
  return {
    keyDailyRemaining: numOrNull(g('x-ratelimit-remaining-daily')),
    keyDailyLimit: numOrNull(g('x-ratelimit-limit-daily')),
    user10minRemaining: numOrNull(g('x-ratelimit-user-10min-remaining')),
    user10minLimit: numOrNull(g('x-ratelimit-user-10min-limit')),
    userDailyRemaining: numOrNull(g('x-ratelimit-user-daily-remaining')),
  };
}
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function estimateInput(anthropicBody) {
  let text = typeof anthropicBody.system === 'string' ? anthropicBody.system : JSON.stringify(anthropicBody.system || '');
  for (const m of anthropicBody.messages || []) text += typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
  for (const t of anthropicBody.tools || []) text += t.name + (t.description || '');
  return estimateTokens(text);
}

function sendJson(res, status, obj, reqLog, t0, statsLike) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
  const s = statsLike?.stats || {};
  log(`done | ${Date.now() - t0}ms | in=${s.inputTokens ?? '?'} out=${s.outputTokens ?? '?'} tools=${s.tools ?? 0} | status=${status}`);
}

/** Reconstruye una respuesta completa a partir del StreamTranslator.
 *  (en desuso desde el streaming sintético; se conserva por compatibilidad) */
function anthropicFromCompleteFromStream(tr, requestedModel) {
  const events = tr.finalize();
  // reconstrucción mínima: usamos stats; el contenido textual completo no se
  // conservó bloque a bloque, así que reconstruimos desde outputText.
  return {
    id: 'msg_' + Date.now().toString(36),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content: [{ type: 'text', text: tr.outputText || '' }],
    stop_reason: tr.sawToolCall ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: tr.stats.inputTokens, output_tokens: tr.stats.outputTokens },
  };
}

// ---------------------------------------------------------------------------
// count_tokens — estimación local (suficiente para gestión de contexto de CC)
// ---------------------------------------------------------------------------
async function handleCountTokens(req, res) {
  try {
    const raw = await readBody(req);
    const b = JSON.parse(raw.toString('utf-8') || '{}');
    let text = typeof b.system === 'string' ? b.system : JSON.stringify(b.system || '');
    for (const m of b.messages || []) {
      text += typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    }
    for (const t of b.tools || []) text += (t.name || '') + (t.description || '') + JSON.stringify(t.input_schema || {});
    const tokens = estimateTokens(text) + (b.messages?.length || 0) * 4;
    const body = JSON.stringify({ input_tokens: tokens });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  } catch (e) {
    anthropicError(res, 400, 'invalid_request_error', e.message);
  }
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  try {
    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      // v4: /health degrada con elegancia si la sesión aún no tiene credenciales
      // (el bridge arranca en cualquier sesión y espera a que el runtime
      // inyecte /etc/.z-ai-config — no muere en el arranque).
      let c = null, cfgErr = null;
      try { c = getConfig(); } catch (e) { cfgErr = e.message; }
      const body = JSON.stringify({
        status: c ? 'ok' : 'waiting-session',
        bridge: 'glm-bridge', version: 4,
        ...(cfgErr ? { config_error: cfgErr } : {}),
        model: c ? resolveModel(c) : (process.env.GLM_MODEL || DEFAULT_MODEL),
        model_env: process.env.GLM_MODEL || null,
        model_config: c?.model || null,
        gateway_echo_model: lastEchoModel,
        upstream: c ? upstreamUrl(c) : null,
        session: c ? {
          chatId: c.chatId || null,
          token: tokenFingerprint(c.token),
          userId: c.userId || null,
          config_mtime: c._mtime ? new Date(c._mtime).toISOString() : null,
        } : null,
        quota_last_seen: lastQuota,
        pid: process.pid,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(body);
    }
    if (req.method === 'POST' && (url === '/v1/messages/count_tokens' || url === '/v1/messages/count_tokens?beta=true')) {
      return await handleCountTokens(req, res);
    }
    if (req.method === 'POST' && (url === '/v1/messages' || url === '/v1/messages?beta=true')) {
      return await handleMessages(req, res);
    }
    return anthropicError(res, 404, 'not_found_error', `ruta no soportada: ${req.method} ${url}`);
  } catch (e) {
    log(`FATAL handler: ${e.stack || e}`);
    if (!res.headersSent) anthropicError(res, 500, 'api_error', 'error interno del bridge');
    else try { res.end(); } catch {}
  }
});

// timeouts generosos: CC puede tener turnos muy largos
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 75000;

server.listen(PORT, HOST, () => {
  log(`GLM-Bridge v4 (portable, session-born) escuchando en http://${HOST}:${PORT} | modelo=${process.env.GLM_MODEL || DEFAULT_MODEL} (por petición: env > fichero de sesión > defecto)`);
  try {
    const c = getConfig();
    log(`creds: ${c._source} | sesión: chatId=${c.chatId || 'sin'} | token=${tokenFingerprint(c.token)} | userId=${c.userId || 'sin'}`);
  } catch (e) {
    log(`creds: AÚN SIN SESIÓN (${e.message}) — el bridge espera y se adapta cuando el runtime inyecte las credenciales`);
  }
  log(`thinking=${THINKING ? 'on' : 'off'} (override por petición activo) | toolHint=${TOOL_HINT ? 'on' : 'off'} | retries=${MAX_RETRIES}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log(`recibido ${sig}, cerrando`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
}
process.on('uncaughtException', (e) => log('uncaughtException: ' + (e.stack || e)));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e?.stack || e)));
