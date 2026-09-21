#!/usr/bin/env node
// ============================================================================
// relay.mjs — GLM-Bridge v6 · transporte "Chat-Brain Relay"
// ============================================================================
// La pieza que cierra el círculo del proyecto: usar EXACTAMENTE lo que ya
// existe y funciona en esta sesión de chat.z.ai, sin lógica externa.
//
//   Claude Code ──HTTP/SSE──▶ GLM-Bridge (transport=relay) ──ficheros──▶ CEREBRO
//   (oficial)   /v1/messages    spool pending/replies        el propio LLM de
//                                                         ESTA sesión de chat
//
// El "modelo" ya no es un upstream HTTP: es el LLM platform-side que genera
// las respuestas de este chat (el mismo que te lee ahora), que actúa como
// cerebro leyendo las peticiones que CC deja en el spool y escribiendo sus
// respuestas como ficheros. Coste de cuota: CERO. Servicios externos: CERO.
// Upstream HTTP: NINGUNO — ni zai ni BYOK.
//
// Protocolo (diseñado sobre mediciones reales de CC 2.1.278 — worklog 15-c):
//  1. CC POST /v1/messages → el bridge calcula el hash canónico del body
//     (idempotente ante los reintentos del SDK de CC, que reenvían el MISMO
//     body con distinto x-stainless-retry-count).
//  2. El bridge escribe pending/<hash>.json (+ <hash>.digest.md legible por
//     el cerebro) y mantiene la conexión abierta en hold HASTA hold_ms
//     (default 40s < 60s del timeout SDK medido).
//  3. El cerebro (yo, o un subagente mío durante el turno) lee el digest,
//     decide el siguiente movimiento de CC y escribe replies/<hash>.json
//     con escritura atómica (.tmp + rename).
//  4. El bridge detecta el fichero, normaliza la respuesta a un message
//     Anthropic completo y responde (JSON o SSE sintético, la ruta que ya
//     existía desde v3). La pareja request/reply se archiva.
//  5. Si el hold expira sin respuesta: 429 + Retry-After → CC reintenta
//     NATIVAMENTE con el mismo body → mismo hash → se reconsulta el spool.
//     El cerebro puede tardar minutos; CC solo sondea con educación.
//
// Formato de respuesta del cerebro (replies/<hash>.json):
//   simple:   {"text": "..."}                          → bloque text + end_turn
//             {"tool_uses": [{"name","input"}]}        → bloques tool_use + tool_use
//             {"text": "...", "tool_uses": [...]}      → ambos (text primero)
//   completo: {"content": [bloques Anthropic], "stop_reason": "..."}  (passthrough)
//
// CLI (cuando se invoca directamente):
//   node relay.mjs pending                     lista peticiones pendientes
//   node relay.mjs answer <hash> <reply.json>  publica una respuesta validada
//   node relay.mjs dirs                        rutas del spool
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { estimateTokens } from './translate.mjs';

// ---------------------------------------------------------------------------
// Configuración (env, cero valores congelados en el código de sesión)
// ---------------------------------------------------------------------------
export const RELAY_CONFIG = {
  dir: process.env.GLM_BRIDGE_RELAY_DIR
    || path.join(os.homedir(), '.glm-claude-bridge', 'relay'),
  // hold por conexión: debe quedarse POR DEBAJO del timeout SDK de CC (60s
  // medido en x-stainless-timeout); pasado ese margen se responde 429 +
  // Retry-After y CC reintenta nativamente (mismo body → mismo hash).
  holdMs: Number(process.env.GLM_BRIDGE_RELAY_HOLD_MS || 40000),
  retryAfterS: Number(process.env.GLM_BRIDGE_RELAY_RETRY_AFTER_S || 5),
  // techo de aplazamientos por petición (bucle infinito si el cerebro muere)
  maxDefers: Number(process.env.GLM_BRIDGE_RELAY_MAX_DEFERS || 60),
  pollMs: Number(process.env.GLM_BRIDGE_RELAY_POLL_MS || 400),
};

function dirs() {
  const root = RELAY_CONFIG.dir;
  return {
    root,
    pending: path.join(root, 'pending'),
    replies: path.join(root, 'replies'),
    archive: path.join(root, 'archive'),
    expired: path.join(root, 'expired'),
  };
}

export function relayInit() {
  for (const d of Object.values(dirs())) fs.mkdirSync(d, { recursive: true });
}

export function relayHealth() {
  const d = dirs();
  const n = (p, suf) => {
    try { return fs.readdirSync(p).filter((f) => f.endsWith(suf)).length; } catch { return 0; }
  };
  return {
    dir: RELAY_CONFIG.dir,
    pending: n(d.pending, '.json'),
    replies_waiting: n(d.replies, '.json'),
    answered_total: n(d.archive, '.reply.json'),
    expired: n(d.expired, '.json'),
  };
}

// ---------------------------------------------------------------------------
// Hash canónico: idempotencia ante reintentos de CC.
// El SDK reenvía el MISMO body al reintentar (solo cambian cabeceras y
// metadata volátil), así que el hash cubre la parte semántica estable:
// model + system + tools (nombre+schema) + messages.
// ---------------------------------------------------------------------------
function canonicalString(body) {
  return JSON.stringify({
    model: body?.model || null,
    system: body?.system || null,
    tools: (Array.isArray(body?.tools) ? body.tools : []).map((t) => ({
      name: t?.name || null, input_schema: t?.input_schema || null,
    })),
    messages: Array.isArray(body?.messages) ? body.messages : [],
  });
}

export function canonicalHash(body) {
  return crypto.createHash('sha256').update(canonicalString(body)).digest('hex').slice(0, 24);
}

// ---------------------------------------------------------------------------
// Escritura atómica: nunca se lee un fichero a medias.
// ---------------------------------------------------------------------------
function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Digest: la vista legible de la petición para el cerebro (yo / subagente).
// El .json completo queda al lado para consultarlo si hace falta.
// ---------------------------------------------------------------------------
function blockText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text') return b.text || '';
      if (b.type === 'tool_use') return `[llama a ${b.name} con ${JSON.stringify(b.input || {}).slice(0, 400)}]`;
      if (b.type === 'tool_result') {
        const inner = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
        return `[resultado de herramienta] ${inner}`;
      }
      if (b.type === 'thinking') return '[razonamiento interno]';
      return `[${b.type}]`;
    }).join('\n');
  }
  return '';
}

function buildDigest(body, hash) {
  const d = dirs();
  const lines = [];
  lines.push(`> CEREBRO DEL CHAT: para responder esta petición escribe el fichero`);
  lines.push(`>   ${path.join(d.replies, hash + '.json')}`);
  lines.push(`> con escritura ATÓMICA (escribe <nombre>.json.tmp y luego rename a .json).`);
  lines.push(`>`);
  lines.push(`> Formato simple aceptado:`);
  lines.push(`>   {"text": "tu mensaje"}`);
  lines.push(`>   {"tool_uses": [{"name": "<nombre EXACTO de la tool>", "input": {...}}]}`);
  lines.push(`>   (puedes combinar ambos; con tool_uses el stop_reason es tool_use)`);
  lines.push(`> Formato avanzado (passthrough Anthropic):`);
  lines.push(`>   {"content": [bloques], "stop_reason": "end_turn|tool_use"}`);
  lines.push(`>`);
  lines.push(`> Si tu respuesta anterior fue rechazada, verás ${hash}.error.txt`);
  lines.push(`> en replies/ con la causa: corrígela y reescribe el .json.`);
  lines.push('');
  lines.push(`# Petición relay ${hash}`);
  lines.push(`model=${body?.model || '—'} | stream=${!!body?.stream} | max_tokens=${body?.max_tokens || '—'} | mensajes=${(body?.messages || []).length} | tools=${(body?.tools || []).length}`);

  const sys = typeof body?.system === 'string'
    ? body.system
    : (Array.isArray(body?.system) ? body.system.map((b) => b?.text || '').join('\n') : JSON.stringify(body?.system || ''));
  lines.push(`\n## system (primeros 1500 chars)\n${String(sys).slice(0, 1500)}`);

  const tools = Array.isArray(body?.tools) ? body.tools : [];
  if (tools.length) {
    lines.push(`\n## tools (${tools.length}) — usa los nombres EXACTOS y respeta input_schema`);
    for (const t of tools) {
      const props = t?.input_schema?.properties ? Object.keys(t.input_schema.properties) : [];
      const req = Array.isArray(t?.input_schema?.required) ? ` [req: ${t.input_schema.required.join(',')}]` : '';
      lines.push(`- ${t?.name}(${props.join(', ')})${req} — ${String(t?.description || '').slice(0, 140).replace(/\s+/g, ' ')}`);
    }
  }

  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  lines.push(`\n## transcript (últimos 10 mensajes, truncados)`);
  for (const m of msgs.slice(-10)) {
    lines.push(`\n### ${m?.role}\n${blockText(m?.content).slice(0, 3000)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Normalización de la respuesta del cerebro → message Anthropic completo
// ---------------------------------------------------------------------------
export function normalizeReply(reply, anthropicBody, requestedModel, hash8) {
  let content;
  let stop;
  if (Array.isArray(reply?.content)) {
    content = reply.content;
    for (const b of content) {
      if (!b || typeof b.type !== 'string') throw new Error('bloque de content sin "type"');
      if (b.type === 'tool_use' && (typeof b.name !== 'string' || typeof b.input !== 'object' || b.input === null)) {
        throw new Error(`tool_use "${b.name || '?'}" sin name/input objeto`);
      }
    }
    stop = typeof reply.stop_reason === 'string' && reply.stop_reason
      ? reply.stop_reason
      : (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
  } else {
    const blocks = [];
    if (typeof reply?.text === 'string' && reply.text.trim().length) {
      blocks.push({ type: 'text', text: reply.text });
    }
    const tus = Array.isArray(reply?.tool_uses) ? reply.tool_uses : [];
    tus.forEach((tu, i) => {
      if (!tu || typeof tu.name !== 'string' || !tu.name) throw new Error(`tool_uses[${i}] sin "name"`);
      blocks.push({
        type: 'tool_use',
        id: (typeof tu.id === 'string' && tu.id) ? tu.id : `toolu_relay_${hash8}${i}`,
        name: tu.name,
        input: (tu.input && typeof tu.input === 'object') ? tu.input : {},
      });
    });
    if (!blocks.length) {
      throw new Error('respuesta vacía: usa {"text": "..."} y/o {"tool_uses": [{"name","input"}]} (o {"content": [...]} completo)');
    }
    content = blocks;
    stop = tus.length ? 'tool_use' : (typeof reply?.stop_reason === 'string' && reply.stop_reason ? reply.stop_reason : 'end_turn');
  }
  const sysTok = estimateTokens(typeof anthropicBody?.system === 'string'
    ? anthropicBody.system : JSON.stringify(anthropicBody?.system || ''));
  const msgTok = estimateTokens(JSON.stringify(anthropicBody?.messages || []));
  const outChars = content.filter((b) => b.type === 'text').reduce((a, b) => a + (b.text || '').length, 0);
  return {
    id: `msg_relay_${hash8}_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel || 'chat-brain',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: sysTok + msgTok, output_tokens: Math.max(1, Math.round(outChars / 3.5)) },
  };
}

// ---------------------------------------------------------------------------
// Spool: lectura, rechazo con feedback, archivo y expiración
// ---------------------------------------------------------------------------
function takeReply(hash) {
  const f = path.join(dirs().replies, hash + '.json');
  if (!fs.existsSync(f)) return null;
  let raw;
  try { raw = fs.readFileSync(f, 'utf-8'); } catch { return null; }
  try { return JSON.parse(raw); } catch (e) {
    rejectReply(hash, `JSON no parseable (¿escritura no atómica?): ${e.message}`);
    return null;
  }
}

function rejectReply(hash, why) {
  const d = dirs();
  const f = path.join(d.replies, hash + '.json');
  try { if (fs.existsSync(f)) fs.renameSync(f, path.join(d.replies, `${hash}.rejected-${Date.now()}.json`)); } catch { /* */ }
  try {
    fs.appendFileSync(
      path.join(d.replies, hash + '.error.txt'),
      `[${new Date().toISOString()}] respuesta rechazada: ${why}\nCorrige el formato y reescribe ${f} (atómicamente).\n`,
    );
  } catch { /* */ }
}

function archivePair(hash) {
  const d = dirs();
  const moves = [
    [path.join(d.replies, hash + '.json'), path.join(d.archive, hash + '.reply.json')],
    [path.join(d.pending, hash + '.json'), path.join(d.archive, hash + '.request.json')],
    [path.join(d.pending, hash + '.digest.md'), path.join(d.archive, hash + '.digest.md')],
  ];
  for (const [from, to] of moves) {
    try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch { /* */ }
  }
  try { fs.rmSync(path.join(d.replies, hash + '.error.txt'), { force: true }); } catch { /* */ }
}

function expirePending(hash) {
  const d = dirs();
  const moves = [
    [path.join(d.pending, hash + '.json'), path.join(d.expired, hash + '.request.json')],
    [path.join(d.pending, hash + '.digest.md'), path.join(d.expired, hash + '.digest.md')],
  ];
  for (const [from, to] of moves) {
    try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch { /* */ }
  }
}

function readDeferCount(pendFile) {
  try { return Number(JSON.parse(fs.readFileSync(pendFile, 'utf-8')).defer_count) || 0; } catch { return 0; }
}

function bumpDefer(pendFile, n) {
  try {
    const env = JSON.parse(fs.readFileSync(pendFile, 'utf-8'));
    env.defer_count = n;
    env.last_defer_at = new Date().toISOString();
    atomicWrite(pendFile, JSON.stringify(env, null, 1));
  } catch { /* */ }
}

async function holdPoll(replyFile) {
  const deadline = Date.now() + RELAY_CONFIG.holdMs;
  for (;;) {
    if (fs.existsSync(replyFile)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, RELAY_CONFIG.pollMs));
  }
}

// ---------------------------------------------------------------------------
// Manejador principal (invocado por bridge.mjs con TRANSPORT=relay)
// ---------------------------------------------------------------------------
export async function relayHandleMessages(ctx) {
  const { res, anthropicBody, requestedModel, reqLog, t0, shortId, responders } = ctx;
  const { sendJson, sendSyntheticStream, anthropicError } = responders;
  relayInit();
  const d = dirs();
  const hash = canonicalHash(anthropicBody);
  const hash8 = hash.slice(0, 8);
  const pendFile = path.join(d.pending, hash + '.json');
  const digestFile = path.join(d.pending, hash + '.digest.md');
  const replyFile = path.join(d.replies, hash + '.json');

  if (!fs.existsSync(pendFile)) {
    atomicWrite(pendFile, JSON.stringify({
      hash, hash8,
      received_at: new Date().toISOString(),
      defer_count: 0,
      model: requestedModel,
      stream: !!anthropicBody.stream,
      request: anthropicBody,
    }, null, 1));
    atomicWrite(digestFile, buildDigest(anthropicBody, hash));
    reqLog(`relay: pending ${hash8} (${(JSON.stringify(anthropicBody).length / 1024).toFixed(1)}KB, msgs=${anthropicBody.messages?.length || 0}, tools=${anthropicBody.tools?.length || 0})`);
  }

  let defers = readDeferCount(pendFile);

  for (;;) {
    const reply = takeReply(hash);
    if (reply !== null) {
      let final = null;
      try {
        final = normalizeReply(reply, anthropicBody, requestedModel, hash8);
      } catch (e) {
        rejectReply(hash, `normalización: ${e.message}`);
      }
      if (final) {
        archivePair(hash);
        reqLog(`relay: RESPONDIDO ${hash8} por el cerebro del chat | total=${Date.now() - t0}ms | defers=${defers} | stop=${final.stop_reason}`);
        if (!anthropicBody.stream) {
          return sendJson(res, 200, final, reqLog, t0, {
            stats: {
              inputTokens: final.usage.input_tokens,
              outputTokens: final.usage.output_tokens,
              tools: final.content.filter((b) => b.type === 'tool_use').length,
              reasoning: 0,
            },
          });
        }
        return sendSyntheticStream(res, final, reqLog, t0, 0, shortId);
      }
      // respuesta inválida apartada con feedback → el cerebro puede corregirla
    }

    if (defers >= RELAY_CONFIG.maxDefers) {
      expirePending(hash);
      reqLog(`relay: AGOTADO ${hash8} tras ${defers} aplazamientos sin respuesta del cerebro`);
      return anthropicError(res, 529, 'overloaded_error',
        `GLM-Bridge relay: el cerebro del chat no respondió a la petición ${hash8} tras ${defers} aplazamientos. ` +
        `Mira ${path.join(d.replies, hash8)}.error.txt si existió un rechazo, y relanza la tarea.`);
    }

    reqLog(`relay: hold ${RELAY_CONFIG.holdMs}ms esperando al cerebro (${hash8}, aplazado ${defers} veces antes)`);
    const appeared = await holdPoll(replyFile);
    if (!appeared) {
      defers += 1;
      bumpDefer(pendFile, defers);
      res.setHeader('retry-after', String(RELAY_CONFIG.retryAfterS));
      return anthropicError(res, 429, 'rate_limit_error',
        `GLM-Bridge relay: el cerebro del chat sigue trabajando la petición ${hash8} (aplazamiento ${defers}). ` +
        `No es un error real: CC reintentará en ${RELAY_CONFIG.retryAfterS}s con la misma petición y la respuesta llegará por el mismo canal.`);
    }
    // la respuesta apareció durante el hold → repetir el bucle para leerla
  }
}

// ---------------------------------------------------------------------------
// CLI directo: node relay.mjs {pending|answer <hash> <reply.json>|dirs}
// ---------------------------------------------------------------------------
function cli(argv) {
  const d = dirs();
  const cmd = argv[0] || 'help';

  if (cmd === 'dirs') {
    console.log(JSON.stringify(d, null, 2));
    return;
  }

  if (cmd === 'pending') {
    relayInit();
    const files = fs.readdirSync(d.pending).filter((f) => f.endsWith('.json') && !f.includes('.tmp'));
    if (!files.length) { console.log('spool sin peticiones pendientes'); return; }
    for (const f of files) {
      try {
        const env = JSON.parse(fs.readFileSync(path.join(d.pending, f), 'utf-8'));
        const msgs = env.request?.messages || [];
        const lastUser = [...msgs].reverse().find((m) => m?.role === 'user');
        const txt = blockText(lastUser?.content).replace(/\s+/g, ' ').slice(0, 110);
        console.log(`${env.hash8 || String(env.hash || '').slice(0, 8)} | defers=${env.defer_count || 0} | tools=${env.request?.tools?.length || 0} | ${txt}`);
      } catch (e) {
        console.log(`${f}: (no parseable: ${e.message})`);
      }
    }
    return;
  }

  if (cmd === 'answer') {
    const [hash, file] = argv.slice(1);
    if (!hash || !file) { console.error('uso: relay.mjs answer <hash> <reply.json>'); process.exit(2); }
    relayInit();
    let reply;
    try { reply = fs.readFileSync(file, 'utf-8'); } catch (e) { console.error(`no pude leer ${file}: ${e.message}`); process.exit(1); }
    let j;
    try { j = JSON.parse(reply); } catch (e) { console.error(`reply no-JSON: ${e.message}`); process.exit(1); }
    try {
      normalizeReply(j, { messages: [], system: '' }, 'chat-brain', hash.slice(0, 8));
    } catch (e) {
      console.error(`reply inválido: ${e.message}`);
      process.exit(1);
    }
    const dest = path.join(d.replies, hash + '.json');
    atomicWrite(dest, reply);
    console.log(`OK: respuesta publicada en ${dest}`);
    return;
  }

  console.log('uso: node relay.mjs {pending|answer <hash> <reply.json>|dirs}');
  console.log(`spool: ${d.root} (pending/ replies/ archive/ expired/)`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) cli(process.argv.slice(2));
