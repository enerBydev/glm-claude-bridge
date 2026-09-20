// ============================================================================
// zai-config.mjs — Carga las credenciales Z.ai (el mismo token del agente)
// Orden: ZAI_CONFIG_PATH > /etc/.z-ai-config > ~/.z-ai-config > ./.z-ai-config
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function loadZaiConfig() {
  const candidates = [
    process.env.ZAI_CONFIG_PATH,
    '/etc/.z-ai-config',
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

/** Cabeceras exactas que el gateway exige (X-Z-AI-From es OBLIGATORIO). */
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
