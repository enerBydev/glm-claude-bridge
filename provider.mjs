// ============================================================================
// provider.mjs — v5: selección de upstream multi-proveedor (BYOK)
//
// 'zai'    (default): identidad session-born de la plataforma (/etc/.z-ai-config)
//          con sus cabeceras X-*, cookie-jar anti-WAF, circuit breaker de buckets
//          x-ratelimit-* y throttle anti-WAF. Bit-idéntico a v4.
// 'openai' (BYOK): CUALQUIER endpoint OpenAI-compat aportado por el usuario
//          (OpenRouter, Groq, Together, Ollama remoto, vLLM...). Auth Bearer
//          estándar, sin cabeceras Z.ai, sin circuit breaker de buckets y sin
//          cuota de plataforma: el techo lo pone el plan del usuario.
//
// Selección: GLM_BRIDGE_PROVIDER explícito (zai|openai) gana; si no, auto-
// detección → 'openai' si existe GLM_BRIDGE_UPSTREAM_BASE_URL, si no 'zai'.
// Sin dependencias externas.
// ============================================================================

import fs from 'node:fs';

/** Resuelve el proveedor activo desde el entorno. Lanza si el valor es inválido. */
export function resolveProvider(env = process.env) {
  const explicit = String(env.GLM_BRIDGE_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'zai' || explicit === 'openai') return explicit;
  if (explicit) {
    throw new Error(`GLM_BRIDGE_PROVIDER inválido: "${explicit}" (valores válidos: zai|openai)`);
  }
  // auto-detección: el caso de uso dominante es "exporto 2-3 vars y funciona"
  return String(env.GLM_BRIDGE_UPSTREAM_BASE_URL || '').trim() ? 'openai' : 'zai';
}

/** Construye el provider BYOK desde el entorno. Lanza si falta lo obligatorio. */
export function createOpenAiProvider(env = process.env) {
  const baseUrl = String(env.GLM_BRIDGE_UPSTREAM_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('GLM_BRIDGE_UPSTREAM_BASE_URL es obligatorio con provider=openai (p.ej. https://openrouter.ai/api/v1, https://api.groq.com/openai/v1, http://host:11434/v1)');
  }
  let key = String(env.GLM_BRIDGE_UPSTREAM_API_KEY ?? '').trim();
  if (!key && env.GLM_BRIDGE_UPSTREAM_API_KEY_FILE) {
    // convención *_FILE: la key vive en un fichero (no en /proc/<pid>/environ)
    try {
      key = fs.readFileSync(env.GLM_BRIDGE_UPSTREAM_API_KEY_FILE, 'utf-8').trim();
    } catch (e) {
      throw new Error(`GLM_BRIDGE_UPSTREAM_API_KEY_FILE ilegible: ${e.message}`);
    }
  }
  const mainModel = String(env.GLM_BRIDGE_UPSTREAM_MODEL || '').trim();
  const smallModel = String(env.GLM_BRIDGE_UPSTREAM_MODEL_SMALL || '').trim() || mainModel;
  let extraHeaders = {};
  if (env.GLM_BRIDGE_UPSTREAM_EXTRA_HEADERS) {
    try {
      extraHeaders = JSON.parse(env.GLM_BRIDGE_UPSTREAM_EXTRA_HEADERS);
      if (!extraHeaders || typeof extraHeaders !== 'object' || Array.isArray(extraHeaders)) {
        throw new Error('debe ser un objeto JSON');
      }
    } catch (e) {
      throw new Error(`GLM_BRIDGE_UPSTREAM_EXTRA_HEADERS inválido: ${e.message}`);
    }
  }
  // mapa explícito REGEX=MODELO (primer match gana; precede al tier small)
  const modelMap = String(env.GLM_BRIDGE_MODEL_MAP || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((kv) => {
      const i = kv.lastIndexOf('=');
      if (i <= 0) throw new Error(`GLM_BRIDGE_MODEL_MAP: entrada sin "REGEX=MODELO": "${kv}"`);
      return [new RegExp(kv.slice(0, i), 'i'), kv.slice(i + 1)];
    });
  return { kind: 'openai', baseUrl, key, mainModel, smallModel, extraHeaders, modelMap };
}

/** Cabeceras upstream BYOK: SOLO Bearer estándar (+ extras del usuario).
 *  Nunca X-Z-AI-From/X-Token/X-Chat-Id/X-User-Id (eso es identidad de sesión zai). */
export function openAiHeaders(p) {
  const h = { 'Content-Type': 'application/json', ...p.extraHeaders };
  if (p.key) h['Authorization'] = `Bearer ${p.key}`;
  return h;
}

/** URL upstream BYOK: un único /chat/completions para todo (las imágenes van
 *  como image_url en el body — translate.mjs ya lo emite — sin ruta visión). */
export function openAiTargetUrl(p) {
  return p.baseUrl + '/chat/completions';
}

/** Mapeo del modelo pedido por CC al modelo del proveedor:
 *  1) GLM_BRIDGE_MODEL_MAP (primer regex que matchee)
 *  2) clase haiku/background (haiku|small|fast|instant) → upstream model "small"
 *  3) cualquier otra cosa (claude-*, glm-*, opus/fable...) → modelo principal */
export function mapUpstreamModelOpenAi(p, requestedModel) {
  const name = String(requestedModel || '');
  for (const [re, target] of p.modelMap) {
    try { if (re.test(name)) return target; } catch { /* regex inválida: ignorar */ }
  }
  if (/haiku|small|fast|instant/i.test(name)) return p.smallModel;
  return p.mainModel;
}

/** Huella segura de la key para /health (nunca la key completa). */
export function keyFingerprint(k) {
  return k ? `cargada (…${String(k).slice(-4)})` : 'sin key';
}
