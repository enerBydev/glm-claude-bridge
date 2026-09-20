// ============================================================================
// translate.mjs — GLM-Bridge: traducción Anthropic Messages API ⇄ GLM (OpenAI)
// Solución original, escrita desde cero. Sin dependencias externas.
// ============================================================================

/** Sufijo de compatibilidad: evita que el gateway/modelo traduzca nombres de
 *  herramientas (defecto observado: `get_weather` -> `Obtener clima`). */
export const TOOL_NAME_HINT =
  '\n\n[SYSTEM NOTE — tool calling protocol] Tool names are technical identifiers, not prose. ' +
  'When you invoke a tool you MUST use its exact `name` string as provided in the tools list, ' +
  'character for character (e.g. "Read", "Bash", "mcp__server__tool"). ' +
  'Never translate, adapt, transliterate or reword a tool name. ' +
  'Arguments must be a valid JSON object matching the tool\'s input_schema.';

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

export function estimateTokens(text = '') {
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x2e80) cjk++; // CJK y rangos cercanos ~1 token/char
  }
  const other = text.length - cjk;
  return Math.max(1, Math.round(cjk + other / 4));
}

const randId = (p) => p + '_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

function normalizeName(n = '') {
  return String(n).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function nameTokens(n = '') {
  // divide camelCase, snake_case, kebab-case, espacios y acentos básicos
  return String(n)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Resuelve el nombre real de una herramienta devuelta por el upstream contra
 * la lista de nombres ofrecidos. Devuelve el nombre original si coincide,
 * null si no hay match razonable.
 */
export function resolveToolName(returnedName, offered) {
  if (!returnedName) return null;
  if (offered.has(returnedName)) return returnedName;
  const norm = normalizeName(returnedName);
  for (const cand of offered) if (normalizeName(cand) === norm) return cand;
  // contención: p.ej. "obtener clima (get_weather)" o prefijos/sufijos añadidos
  for (const cand of offered) {
    const cn = normalizeName(cand);
    if (cn.length >= 4 && (norm.includes(cn) || cn.includes(norm))) return cand;
  }
  if (offered.size === 1) return [...offered][0]; // única herramienta ofrecida
  // score por solapamiento de tokens
  const rt = new Set(nameTokens(returnedName));
  if (rt.size) {
    let best = null, bestScore = 0;
    for (const cand of offered) {
      const ct = nameTokens(cand);
      if (!ct.length) continue;
      const hit = ct.filter((t) => rt.has(t)).length;
      const score = hit / Math.max(ct.length, 1);
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    if (best && bestScore >= 0.5) return best;
  }
  return null;
}

const STOP_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

export function mapStopReason(fr) {
  return STOP_MAP[fr] || 'end_turn';
}

// ---------------------------------------------------------------------------
// Request: Anthropic -> GLM (formato OpenAI)
// ---------------------------------------------------------------------------

function extractSystem(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => !b || b.type === 'text')
      .map((b) => (typeof b === 'string' ? b : b.text || ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text') parts.push(b.text || '');
    else if (b.type === 'image') parts.push(`[imagen ${b.source?.media_type || 'desconocida'} no reenviable como tool_result]`);
    else if (b.type === 'document') parts.push('[documento adjunto omitido]');
  }
  return parts.join('\n');
}

/** Traduce el array de mensajes Anthropic al formato OpenAI/GLM. */
export function translateMessages(messages = []) {
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    if (msg.role === 'user') {
      // 1) tool_result -> mensajes role:'tool' (en orden)
      // 2) texto/imágenes restantes -> mensaje user con partes
      const parts = [];
      for (const b of msg.content) {
        if (b && b.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: b.tool_use_id || randId('call'),
            content: toolResultText(b.content),
          });
        }
      }
      for (const b of msg.content) {
        if (!b) continue;
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') {
          const src = b.source || {};
          const url =
            src.type === 'url' ? src.url
            : src.type === 'base64' ? `data:${src.media_type || 'image/png'};base64,${src.data || ''}`
            : null;
          if (url) parts.push({ type: 'image_url', image_url: { url } });
        } else if (b.type === 'document') {
          parts.push({ type: 'text', text: '[documento PDF adjunto: no soportado por el modelo, ignóralo]' });
        }
      }
      if (parts.length === 1 && parts[0].type === 'text') {
        out.push({ role: 'user', content: parts[0].text });
      } else if (parts.length) {
        out.push({ role: 'user', content: parts });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const text = msg.content
        .filter((b) => b && b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('');
      const toolCalls = [];
      for (const b of msg.content) {
        if (b && b.type === 'tool_use') {
          toolCalls.push({
            id: b.id || randId('toolu'),
            type: 'function',
            function: {
              name: b.name,
              arguments: safeStringify(b.input),
            },
          });
        }
      }
      const m = { role: 'assistant', content: text || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
      continue;
    }

    // otros roles desconocidos: reenvío literal prudente
    out.push({ role: msg.role, content: '' });
  }
  return out;
}

function safeStringify(v) {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return '{}';
  }
}

export function translateTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    if (!t || typeof t.name !== 'string') continue;
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : { type: 'object', properties: {} },
      },
    });
  }
  return out;
}

export function translateToolChoice(tc) {
  if (!tc) return undefined;
  switch (tc.type) {
    case 'auto': return 'auto';
    case 'none': return 'none';
    case 'any': return 'required';
    case 'tool': return tc.name ? { type: 'function', function: { name: tc.name } } : 'auto';
    default: return undefined;
  }
}

/**
 * Construye el cuerpo del request hacia el upstream GLM.
 * opts: { model, thinking (bool), toolHint (bool) }
 */
export function buildUpstreamRequest(anthropicBody, opts = {}) {
  const model = opts.model || anthropicBody.model || 'glm-5.3-flash';
  const messages = [];
  const sys = extractSystem(anthropicBody.system);
  const tools = translateTools(anthropicBody.tools);
  if (sys || tools.length) {
    messages.push({ role: 'system', content: (sys || '') + (tools.length && opts.toolHint !== false ? TOOL_NAME_HINT : '') });
  }
  messages.push(...translateMessages(anthropicBody.messages));

  const body = {
    model,
    messages,
    max_tokens: clampMaxTokens(anthropicBody.max_tokens),
    stream: !!anthropicBody.stream,
    thinking: { type: opts.thinking ? 'enabled' : 'disabled' },
  };
  if (anthropicBody.temperature != null) body.temperature = bodyNum(anthropicBody.temperature);
  if (anthropicBody.top_p != null) body.top_p = bodyNum(anthropicBody.top_p);
  if (Array.isArray(anthropicBody.stop_sequences) && anthropicBody.stop_sequences.length) {
    body.stop = anthropicBody.stop_sequences;
  }
  if (tools.length) {
    body.tools = tools;
    const tc = translateToolChoice(anthropicBody.tool_choice);
    if (tc) body.tool_choice = tc;
  }
  return body;
}

function bodyNum(v) { return typeof v === 'number' ? v : Number(v) || undefined; }

function clampMaxTokens(mt) {
  const n = Number(mt);
  if (!Number.isFinite(n) || n <= 0) return 8192;
  return Math.min(Math.max(Math.floor(n), 16), 32768);
}

// ---------------------------------------------------------------------------
// Response completa (no streaming): GLM -> Anthropic
// ---------------------------------------------------------------------------

export function anthropicFromComplete(up, requestedModel, offeredNames) {
  const choice = (up.choices && up.choices[0]) || {};
  const m = choice.message || {};
  const content = [];
  let text = typeof m.content === 'string' ? m.content : '';
  const offered = offeredNames instanceof Set ? offeredNames : new Set(offeredNames || []);

  for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
    const name = resolveToolName(tc?.function?.name, offered);
    let input = {};
    try { input = JSON.parse(tc?.function?.arguments || '{}'); } catch { input = { _raw: tc?.function?.arguments }; }
    if (name) {
      content.push({ type: 'tool_use', id: tc.id || randId('toolu'), name, input });
    } else {
      text += `\n[glm-bridge] El modelo intentó invocar una herramienta desconocida "${tc?.function?.name}" con: ${JSON.stringify(input).slice(0, 500)}. Usa exactamente los nombres de herramienta disponibles.`;
    }
  }
  if (text) content.unshift({ type: 'text', text });

  return {
    id: up.id ? 'msg_' + up.id : randId('msg'),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: up.usage?.prompt_tokens ?? 0,
      output_tokens: up.usage?.completion_tokens ?? estimateTokens(text),
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming: máquina de estados GLM (SSE OpenAI) -> eventos Anthropic
// ---------------------------------------------------------------------------

export class StreamTranslator {
  constructor({ requestedModel, offeredNames = [], inputTokensEstimate = 0 } = {}) {
    this.requestedModel = requestedModel;
    this.offered = offeredNames instanceof Set ? offeredNames : new Set(offeredNames);
    this.inputEstimate = inputTokensEstimate;
    this.started = false;
    this.finished = false;
    this.nextIndex = 0;
    this.current = null; // { index, type:'text'|'tool_use' }
    this.toolBlocks = new Map(); // upstream tool index -> estado
    this.outputText = '';
    this.finishReason = null;
    this.usage = null;
    this.sawToolCall = false;
  }

  #emit(event, data) { return { event, data }; }

  start() {
    this.started = true;
    return [
      this.#emit('message_start', {
        type: 'message_start',
        message: {
          id: randId('msg'),
          type: 'message',
          role: 'assistant',
          model: this.requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputEstimate, output_tokens: 1 },
        },
      }),
      this.#emit('ping', { type: 'ping' }),
    ];
  }

  #closeCurrent() {
    if (!this.current) return [];
    const ev = this.#emit('content_block_stop', { type: 'content_block_stop', index: this.current.index });
    this.current = null;
    return [ev];
  }

  #openText() {
    this.current = { index: this.nextIndex++, type: 'text' };
    return [
      this.#emit('content_block_start', {
        type: 'content_block_start',
        index: this.current.index,
        content_block: { type: 'text', text: '' },
      }),
    ];
  }

  #openTool(id, name) {
    this.current = { index: this.nextIndex++, type: 'tool_use' };
    return [
      this.#emit('content_block_start', {
        type: 'content_block_start',
        index: this.current.index,
        content_block: { type: 'tool_use', id, name, input: {} },
      }),
    ];
  }

  /** Procesa un chunk JSON del upstream; devuelve eventos a emitir. */
  handleChunk(chunk) {
    if (this.finished) return [];
    const out = [];

    if (!this.started) out.push(...this.start());

    if (chunk.usage) this.usage = chunk.usage;

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) return out;

    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta || {};

    // delta.reasoning_content se ignora por diseño (thinking deshabilitado upstream)

    const txt = typeof delta.content === 'string' ? delta.content : '';
    if (txt) {
      if (!this.current || this.current.type !== 'text') {
        out.push(...this.#closeCurrent());
        out.push(...this.#openText());
      }
      this.outputText += txt;
      out.push(this.#emit('content_block_delta', {
        type: 'content_block_delta',
        index: this.current.index,
        delta: { type: 'text_delta', text: txt },
      }));
    }

    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const idx = Number.isInteger(tc.index) ? tc.index : this.toolBlocks.size;
      let st = this.toolBlocks.get(idx);
      if (!st) {
        this.sawToolCall = true;
        const resolved = resolveToolName(tc?.function?.name || '', this.offered);
        const id = tc.id || randId('toolu');
        out.push(...this.#closeCurrent());
        if (resolved) {
          out.push(...this.#openTool(id, resolved));
          st = { blockIndex: this.current.index, id, name: resolved, unknown: false };
        } else {
          // contingencia: degradar a texto para que CC pueda recuperarse
          out.push(...this.#openText());
          st = { blockIndex: this.current.index, id, name: tc?.function?.name || '?', unknown: true };
          this.toolBlocks.set(idx, st);
          const warn = `\n[glm-bridge] intento de llamada a herramienta desconocida "${st.name}": `;
          out.push(this.#emit('content_block_delta', {
            type: 'content_block_delta',
            index: st.blockIndex,
            delta: { type: 'text_delta', text: warn },
          }));
          this.outputText += warn;
        }
        this.toolBlocks.set(idx, st);
        // sin `continue`: el primer fragmento de argumentos del propio chunk
        // debe emitirse también (antes se descartaba y corrompía el JSON).
      }
      if (st.unknown) continue;
      const frag = tc?.function?.arguments;
      if (frag) {
        out.push(this.#emit('content_block_delta', {
          type: 'content_block_delta',
          index: st.blockIndex,
          delta: { type: 'input_json_delta', partial_json: frag },
        }));
      }
    }

    return out;
  }

  /** Cierra el stream; devuelve eventos finales. */
  finalize() {
    if (this.finished) return [];
    this.finished = true;
    const events = [];
    if (!this.started) events.push(...this.start());
    events.push(...this.#closeCurrent());

    const stopReason = this.finishReason
      ? mapStopReason(this.finishReason)
      : (this.sawToolCall ? 'tool_use' : 'end_turn');

    const outputTokens = this.usage?.completion_tokens ?? Math.max(1, estimateTokens(this.outputText));
    events.push(this.#emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: this.usage?.prompt_tokens ?? this.inputEstimate,
        output_tokens: outputTokens,
      },
    }));
    events.push(this.#emit('message_stop', { type: 'message_stop' }));
    return events;
  }

  get stats() {
    return {
      inputTokens: this.usage?.prompt_tokens ?? this.inputEstimate,
      outputTokens: this.usage?.completion_tokens ?? estimateTokens(this.outputText),
      chars: this.outputText.length,
      tools: this.toolBlocks.size,
    };
  }
}
