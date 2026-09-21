// ============================================================================
// zai-config.mjs — Carga las credenciales Z.ai (el mismo token del agente)
// Orden: ZAI_CONFIG_PATH > /etc/.z-ai-config > ~/.z-ai-config > ./.z-ai-config
// QA: con GLM_QA_HIDE_SESSION=1 se omite /etc/.z-ai-config (seam de
// testabilidad para reproducir localmente un entorno "sin sesión").
//
// v3 (session-born): el runtime de la plataforma RE-INYECTA el token JWT de
// sesión (X-Token) y la identidad del chat (X-Chat-Id/X-User-Id) en
// /etc/.z-ai-config en cada arranque/continuación de la conversación.
// Ese token es OBLIGATORIO para el gateway (sin él: 401 "missing X-Token
// header") y abre además el bucket de cuota user-level (200/día, 30/10min).
// Por eso el bridge NO puede cachear las cabeceras eternamente: se sirve un
// PROVIDER que relee el fichero cuando cambia su mtime.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function loadZaiConfig() {
  const hideEtc = process.env.GLM_QA_HIDE_SESSION === '1';
  const candidates = [
    process.env.ZAI_CONFIG_PATH,
    hideEtc ? null : '/etc/.z-ai-config',
    path.join(os.homedir(), '.z-ai-config'),
    path.join(process.cwd(), '.z-ai-config'),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const cfg = JSON.parse(raw);
      if (cfg.baseUrl && cfg.apiKey) {
        return { ...cfg, _source: p };
      }
    } catch { /* siguiente candidato */ }
  }
  throw new Error(
    'No se encontró configuración Z.ai válida (baseUrl+apiKey). ' +
    'Crea /etc/.z-ai-config o define ZAI_CONFIG_PATH.'
  );
}

/**
 * Provider de configuración con recarga automática: relee el fichero de
 * credenciales cuando su mtime cambia (la plataforma re-inyecta el token de
 * sesión en cada nueva conversación/continuación). Cachea por mtime, así que
 * el coste por petición es un stat local.
 */
export function createConfigProvider() {
  let cached = null;
  let cachedMtimeMs = -1;
  return function getConfig() {
    try {
      const p = configPath();
      const st = fs.statSync(p);
      if (!cached || st.mtimeMs !== cachedMtimeMs) {
        const fresh = loadZaiConfig();
        fresh._mtime = st.mtimeMs;
        const changed = cached !== null;
        cached = fresh;
        cachedMtimeMs = st.mtimeMs;
        if (changed) fresh._reloaded = true;
      }
    } catch {
      // stat/read falló: conservar la config previa (el gateway puede seguir
      // aceptándola brevemente) en vez de tumbar el bridge.
    }
    if (!cached) return loadZaiConfig(); // primer arranque sin fichero legible: error ruidoso
    return cached;
  };
}

function configPath() {
  const hideEtc = process.env.GLM_QA_HIDE_SESSION === '1';
  const candidates = [
    process.env.ZAI_CONFIG_PATH,
    hideEtc ? null : '/etc/.z-ai-config',
    path.join(os.homedir(), '.z-ai-config'),
    path.join(process.cwd(), '.z-ai-config'),
  ].filter(Boolean);
  return candidates[0];
}

/** Huella segura del token para logs (nunca el token completo). */
export function tokenFingerprint(token) {
  if (!token) return 'ausente';
  return `cargado (...${String(token).slice(-8)})`;
}

/** Cabeceras exactas que el gateway exige (X-Z-AI-From es OBLIGATORIO).
 *  Desde la política vigente, X-Token (JWT de sesión) también es OBLIGATORIO:
 *  sin él el gateway responde 401 {"error":"missing X-Token header"}. */
export function upstreamHeaders(cfg) {
  const h = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.apiKey}`,
    'X-Z-AI-From': 'Z',
  };
  if (cfg.chatId) h['X-Chat-Id'] = cfg.chatId;
  if (cfg.userId) h['X-User-Id'] = cfg.userId;
  if (cfg.token) h['X-Token'] = cfg.token;
  return h;
}

export function upstreamUrl(cfg) {
  return cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

/** Endpoint de visión: el gateway sólo acepta imágenes aquí. */
export function upstreamVisionUrl(cfg) {
  return cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions/vision';
}
