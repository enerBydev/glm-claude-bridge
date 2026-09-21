#!/usr/bin/env node
// ============================================================================
// mock-upstream.mjs — gateway GLM simulado, determinista y sin cuota.
// Permite QA completo del bridge (E2E) SIN tocar el gateway real de Z.ai.
//
// Comportamiento por marcadores en el último mensaje del usuario:
//   MOCK:TASK   → respuesta con tool_call de Task (spawn de subagente;
//                 run_in_background:false para bucle determinista)
//   MOCK:TOOL   → respuesta con tool_calls (Bash)
//   MOCK:THINK  → respuesta con reasoning_content + contenido
//   (defecto)   → eco: "MOCK-OK <última línea del prompt>"
// BUCLE AGÉNTICO: si algún mensaje trae role:'tool' (resultado de herramienta
// devuelto por el cliente a través del bridge), el mock CIERRA el bucle con
// texto "AGENTIC-LOOP-OK <salida>" en vez de pedir otra tool_call (evita
// bucles infinitos y permite afirmar que ida y vuelta de herramientas funciona).
// Routing:
//   POST /chat/completions        → texto/tools/thinking (model "mock-glm-echo")
//   POST /chat/completions/vision → mismo shape (model "glm-5v-turbo")
// Modo global por control-plane (para pruebas de fallo):
//   POST /__mock/mode {"mode":"always-429"|"auth-required"|"bearer-auth-required"|"model-not-found"|"normal"}
// Observabilidad (assertions):
//   GET  /__mock/requests → [{url, method, headers, body}] de TODAS las llamadas
//   POST /__mock/reset    → vacía la captura y vuelve a modo normal
//
// Node ≥ 18, cero dependencias.
// ============================================================================
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8790);
const captured = [];   // {url, method, headers, body}
let mode = 'normal';   // normal | always-429 | auth-required | bearer-auth-required | model-not-found

function quotaHeaders(freeze) {
  // bucket key agotado cuando freeze → el bridge debe hacer fail-fast
  return {
    'x-ratelimit-limit-daily': '300',
    'x-ratelimit-remaining-daily': freeze ? '0' : '299',
    'x-ratelimit-user-10min-limit': '30',
    'x-ratelimit-user-10min-remaining': freeze ? '0' : '29',
    'x-ratelimit-user-daily-remaining': freeze ? '0' : '199',
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(body);
}

function lastUserText(bodyObj) {
  const msgs = Array.isArray(bodyObj?.messages) ? bodyObj.messages : [];
  const lastUser = [...msgs].reverse().find((m) => m?.role === 'user');
  const c = lastUser?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b?.type === 'text' ? b.text : `[${b?.type}]`)).join(' ');
  return '';
}

function flatContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (b?.type === 'text') return b.text;
      if (b?.type === 'tool_result') return typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      return `[${b?.type || 'bloque'}]`;
    }).join(' ');
  }
  return JSON.stringify(c ?? '');
}

function completion(bodyObj, model) {
  const msgs = Array.isArray(bodyObj?.messages) ? bodyObj.messages : [];
  // PRIORITARIO: ¿ya volvió un resultado de herramienta? → cerrar bucle agéntico
  const toolMsg = msgs.find((m) => m?.role === 'tool');
  if (toolMsg) {
    const out = flatContent(toolMsg.content).replace(/\s+/g, ' ').trim().slice(0, 300);
    return {
      id: 'chatcmpl-mock-close-' + Date.now().toString(36),
      object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: `AGENTIC-LOOP-OK salida de herramienta recibida: ${out || '(vacía)'}` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 13, completion_tokens: 9, total_tokens: 22 },
    };
  }
  const text = lastUserText(bodyObj);
  const marker = text.includes('MOCK:TASK') ? 'task'
    : text.includes('MOCK:TOOL') ? 'tool'
    : text.includes('MOCK:THINK') ? 'think' : 'echo';
  const msg = { role: 'assistant', content: null };

  if (marker === 'task') {
    // workflow agéntico: pedir el spawn de un subagente. Las tools llegan en
    // formato OpenAI {type:'function', function:{name}} (el bridge las
    // traduce); mapear function.name con fallback al plano por compatibilidad.
    const names = (Array.isArray(bodyObj?.tools) ? bodyObj.tools : [])
      .map((t) => t?.function?.name || t?.name).filter(Boolean);
    const taskName = ['Task', 'Agent'].find((n) => names.includes(n))
      || names.find((n) => /^(task|agent)$/i.test(n))
      || 'Task';
    msg.content = null;
    msg.tool_calls = [{
      id: 'toolu_mock_task_1', type: 'function',
      function: { name: taskName, arguments: JSON.stringify({
        description: 'subagente mock',
        prompt: 'Di exactamente MOCK-SUBAGENT-OK y nada más.',
        subagent_type: 'general-purpose',
        run_in_background: false,
      }) },
    }];
  } else if (marker === 'tool') {
    msg.content = null;
    msg.tool_calls = [{
      id: 'toolu_mock_1', type: 'function',
      function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo mock-tool-ok' }) },
    }];
  } else if (marker === 'think') {
    msg.reasoning_content = 'Paso 1: analizo. Paso 2: concluyo.';
    msg.content = 'MOCK-THINK-OK';
  } else {
    msg.content = `MOCK-OK ${text.trim().split('\n').pop() || ''}`.trim();
  }

  return {
    id: 'chatcmpl-mock-' + Date.now().toString(36),
    object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: msg, finish_reason: (marker === 'tool' || marker === 'task') ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
  // nota: los mensajes tool_result de Anthropic llegan traducidos a role:'tool'
  // (translate.mjs), por eso el cierre del bucle puede detectarse arriba.
}

function sseChunks(res, bodyObj, model) {
  const base = completion(bodyObj, model);
  const msg = base.choices[0].message;
  const chunks = [];
  chunks.push({ choices: [{ delta: { role: 'assistant' }, index: 0 }] });
  if (msg.reasoning_content) chunks.push({ choices: [{ delta: { reasoning_content: msg.reasoning_content }, index: 0 }] });
  if (typeof msg.content === 'string') chunks.push({ choices: [{ delta: { content: msg.content }, index: 0 }] });
  if (msg.tool_calls) {
    chunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: msg.tool_calls[0].id, type: 'function', function: { name: msg.tool_calls[0].function.name, arguments: '' } }] }, index: 0 }] });
    chunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: msg.tool_calls[0].function.arguments } }] }, index: 0 }] });
  }
  chunks.push({ choices: [{ delta: {}, finish_reason: base.choices[0].finish_reason, index: 0 }] });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...quotaHeaders(false) });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ ...c, id: base.id, object: 'chat.completion.chunk', created: base.created, model })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  // el gateway real vive bajo /v1 (baseUrl=.../v1 + /chat/completions):
  // normalizamos para aceptar ambas formas.
  const url = (req.url || '').split('?')[0].replace(/^\/v1(?=\/)/, '');
  const body = await readBody(req);
  let bodyObj = null;
  try { bodyObj = JSON.parse(body || '{}'); } catch { /* no-json */ }

  // ---- control plane (no se cuenta como llamada upstream) ----
  if (url === '/__mock/mode') {
    mode = bodyObj?.mode || 'normal';
    return sendJson(res, 200, { mode });
  }
  if (url === '/__mock/requests') {
    return sendJson(res, 200, { count: captured.length, requests: captured });
  }
  if (url === '/__mock/reset') {
    captured.length = 0; mode = 'normal';
    return sendJson(res, 200, { ok: true });
  }

  // ---- captura de TODO lo que el bridge envíe al "gateway" ----
  captured.push({ url: req.url, method: req.method, headers: { ...req.headers }, body: bodyObj });

  // ---- modos de fallo (para fail-fast / auth) ----
  if (mode === 'always-429') {
    return sendJson(res, 429, { error: { code: '1302', message: 'cuota simulada agotada' } }, quotaHeaders(true));
  }
  if (mode === 'auth-required' && !req.headers['x-token']) {
    return sendJson(res, 401, { error: 'missing X-Token header' });
  }
  // v5: fallos estilo proveedor OpenAI-compat (para los tests BYOK)
  if (mode === 'bearer-auth-required') {
    // simula SIEMPRE key inválida/rechazada (error OpenAI estándar)
    return sendJson(res, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
  }
  if (mode === 'model-not-found') {
    return sendJson(res, 404, { error: { message: `The model '${bodyObj?.model || '?'}' does not exist`, type: 'invalid_request_error', code: 'model_not_found' } });
  }

  // ---- rutas del gateway ----
  if (req.method === 'POST' && url === '/chat/completions/vision') {
    if (bodyObj?.stream) return sseChunks(res, bodyObj, 'glm-5v-turbo');
    return sendJson(res, 200, completion(bodyObj, 'glm-5v-turbo'), quotaHeaders(false));
  }
  if (req.method === 'POST' && url === '/chat/completions') {
    if (bodyObj?.stream) return sseChunks(res, bodyObj, 'mock-glm-echo');
    return sendJson(res, 200, completion(bodyObj, 'mock-glm-echo'), quotaHeaders(false));
  }
  return sendJson(res, 404, { error: `mock: ruta no soportada ${req.method} ${url}` });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock-upstream listo en http://127.0.0.1:${PORT} (modos: normal|always-429|auth-required|bearer-auth-required|model-not-found)`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
