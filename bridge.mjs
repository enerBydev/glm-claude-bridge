#!/usr/bin/env node
// ============================================================================
// bridge.mjs — GLM-Bridge
// Servidor local que expone la API de Messages de Anthropic y la traduce a
// GLM (endpoint OpenAI-compat) usando las credenciales Z.ai del agente.
// Escrito desde cero para este proyecto. Sin dependencias externas.
//
//   Claude Code  ──HTTP/SSE──▶  GLM-Bridge  ──HTTP/SSE──▶  internal-api.z.ai
//   (oficial)     /v1/messages   este proceso            /chat/completions
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadZaiConfig, upstreamHeaders, upstreamUrl, upstreamVisionUrl } from './zai-config.mjs';
import {
  buildUpstreamRequest,
  anthropicFromComplete,
  StreamTranslator,
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
const IDLE_TIMEOUT_MS = Number(process.env.GLM_BRIDGE_IDLE_MS || 300000);
const LOG_DIR = path.join(__dirname, 'logs');

const cfg = loadZaiConfig();
const UPSTREAM = upstreamUrl(cfg);
const UPSTREAM_VISION = upstreamVisionUrl(cfg);
const HEADERS = upstreamHeaders(cfg);

// último "model" que el gateway declaró servir en su eco (puede ser cosmético)
let lastEchoModel = null;

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

async function fetchUpstream(bodyObj, reqLog, targetUrl = UPSTREAM) {
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
        headers: HEADERS,
        body: JSON.stringify(bodyObj),
      });
      if (!res.ok && RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
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

  const requestedModel = anthropicBody.model || DEFAULT_MODEL;
  // cualquier modelo no-GLM se dirige al modelo por defecto del bridge
  const upstreamModel = /^glm/i.test(requestedModel) ? requestedModel : DEFAULT_MODEL;

  const offeredNames = new Set(
    (Array.isArray(anthropicBody.tools) ? anthropicBody.tools : [])
      .map((t) => t?.name).filter(Boolean)
  );

  // ojo: en Node 24 los chunks de fetch.body son Uint8Array (no Buffer):
  // .toString() daría los códigos de byte unidos por comas. Usar TextDecoder.
  const decoder = new TextDecoder('utf-8');

  const upstreamBody = buildUpstreamRequest(anthropicBody, {
    model: upstreamModel,
    thinking: THINKING,
    toolHint: TOOL_HINT,
  });

  // routing de visión: el gateway sólo acepta imágenes en /chat/completions/vision
  const hasImages = (anthropicBody.messages || []).some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b && b.type === 'image')
  );
  const targetUrl = hasImages ? UPSTREAM_VISION : UPSTREAM;

  const shortId = Math.random().toString(36).slice(2, 8);
  const reqLog = (m) => log(`req ${shortId} | ${m}`);
  if (hasImages) reqLog(`routing: petición con imágenes -> ${targetUrl}`);
  reqLog(`${req.method} ${req.url} | modelo_up=${upstreamModel} | stream=${!!anthropicBody.stream} | msgs=${anthropicBody.messages?.length || 0} | tools=${offeredNames.size}`);

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
    const mapped = mapUpstreamStatus(upRes.status);
    return anthropicError(res, mapped.status, mapped.type, `upstream GLM ${upRes.status}: ${txt.slice(0, 300)}`);
  }

  // ---------- No streaming ----------
  if (!anthropicBody.stream) {
    const ct = upRes.headers.get('content-type') || '';
    if (ct.includes('event-stream')) {
      // upstream decidió hacer streaming aunque no se pidió: acumular y fusionar
      const tr = new StreamTranslator({
        requestedModel, offeredNames,
        inputTokensEstimate: estimateInput(anthropicBody),
      });
      let sseBuf = '';
      const parser = sseLineParser((payload) => {
        if (payload === '[DONE]') return;
        try {
          const obj = JSON.parse(payload);
          if (obj.model && !lastEchoModel) { lastEchoModel = obj.model; reqLog(`eco gateway model=${obj.model}`); }
          for (const ev of tr.handleChunk(obj)) {}
        } catch {}
      });
      for await (const chunk of upRes.body) {
        sseBuf = decoder.decode(chunk, { stream: true });
        parser(sseBuf);
      }
      const final = anthropicFromCompleteFromStream(tr, requestedModel);
      return sendJson(res, 200, final, reqLog, t0, tr);
    }
    let upJson;
    try { upJson = JSON.parse(await upRes.text()); }
    catch (e) { return anthropicError(res, 502, 'api_error', 'respuesta upstream no-JSON: ' + e.message); }
    if (upJson.model) { lastEchoModel = upJson.model; reqLog(`eco gateway model=${upJson.model}`); }
    const final = anthropicFromComplete(upJson, requestedModel, offeredNames);
    return sendJson(res, 200, final, reqLog, t0, { stats: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens, tools: final.content.filter(b => b.type === 'tool_use').length } });
  }

  // ---------- Streaming ----------
  const ct = upRes.headers.get('content-type') || '';
  if (!ct.includes('event-stream') && !ct.includes('text/plain')) {
    // error diferido que llegó como JSON con 200
    let msg = 'upstream no devolvió event-stream';
    try { const j = JSON.parse(await upRes.text()); msg = j?.error?.message || JSON.stringify(j).slice(0, 300); } catch {}
    reqLog('upstream 200 sin SSE: ' + msg);
    return anthropicError(res, 502, 'api_error', msg);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const tr = new StreamTranslator({
    requestedModel,
    offeredNames,
    inputTokensEstimate: estimateInput(anthropicBody),
  });

  const writeEvent = ({ event, data }) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let clientGone = false;
  // ojo: 'close' de `req` dispara al terminar de LEER el body (no indica
  // desconexión); la señal fiable es 'close' de `res` sin writableEnded.
  res.on('close', () => { if (!res.writableEnded) clientGone = true; });

  // watchdog de inactividad
  let idleTimer = setTimeout(() => {
    reqLog('watchdog: sin datos del upstream ' + IDLE_TIMEOUT_MS + 'ms, abortando');
    try { upRes.body?.destroy(new Error('idle timeout')); } catch {}
  }, IDLE_TIMEOUT_MS);
  const kick = () => { idleTimer.refresh(); };

  // message_start + ping
  for (const ev of tr.start()) writeEvent(ev);

  let sseFailures = 0;
  const DEBUG = process.env.GLM_BRIDGE_DEBUG === '1';
  let nChunks = 0, nPayloads = 0;
  const onData = (payload) => {
    if (DEBUG) nPayloads++;
    if (clientGone) return;
    if (payload === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(payload); } catch { return; }
    if (obj.model && !lastEchoModel) { lastEchoModel = obj.model; reqLog(`eco gateway model=${obj.model}`); }
    try {
      for (const ev of tr.handleChunk(obj)) writeEvent(ev);
    } catch (e) {
      if (++sseFailures < 3) reqLog('fallo traduciendo chunk: ' + e.message);
    }
  };
  const parser = sseLineParser(onData);

  try {
    for await (const chunk of upRes.body) {
      if (DEBUG && nChunks < 3) reqLog('chunk #' + nChunks + ' len=' + chunk.length + ' head=' + JSON.stringify(decoder.decode(chunk.slice(0, 80))));
      nChunks++;
      if (clientGone) { reqLog('clientGone tras chunk ' + nChunks); break; }
      kick();
      parser(decoder.decode(chunk, { stream: true }));
    }
  } catch (e) {
    reqLog('stream upstream interrumpido: ' + (e?.message || e));
    if (!clientGone && !res.writableEnded) {
      writeEvent({ event: 'error', data: { type: 'error', error: { type: 'api_error', message: 'stream interrumpido: ' + (e?.message || e) } } });
    }
  }
  clearTimeout(idleTimer);
  if (DEBUG) reqLog(`fin lectura: chunks=${nChunks} payloads=${nPayloads} clientGone=${clientGone}`);

  for (const ev of tr.finalize()) writeEvent(ev);
  try { res.end(); } catch {}

  const s = tr.stats;
  log(`req ${shortId} | OK stream | ${Date.now() - t0}ms | in=${s.inputTokens} out=${s.outputTokens} tools=${s.tools} chars=${s.chars}`);
}

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

/** Reconstruye una respuesta completa a partir del StreamTranslator. */
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
      const body = JSON.stringify({ status: 'ok', bridge: 'glm-bridge', model: DEFAULT_MODEL, gateway_echo_model: lastEchoModel, upstream: UPSTREAM, pid: process.pid });
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
  log(`GLM-Bridge escuchando en http://${HOST}:${PORT} | modelo=${DEFAULT_MODEL} | upstream=${UPSTREAM}`);
  log(`creds: ${cfg._source} | thinking=${THINKING ? 'on' : 'off'} | toolHint=${TOOL_HINT ? 'on' : 'off'} | retries=${MAX_RETRIES}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log(`recibido ${sig}, cerrando`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
}
process.on('uncaughtException', (e) => log('uncaughtException: ' + (e.stack || e)));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e?.stack || e)));
