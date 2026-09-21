#!/usr/bin/env bash
# ============================================================================
# glm-claude-bridge — instalador portable para CUALQUIER sesión de chat.z.ai
#
#   git clone https://github.com/enerBydev/glm-claude-bridge.git
#   cd glm-claude-bridge && ./install.sh
#   glm-claude "hola"        # ← Claude Code nativo sobre el modelo de la sesión
#
# Principios:
#   • CERO credenciales hardcodeadas: todo se resuelve en tiempo de ejecución
#     desde el fichero de nacimiento de la sesión (/etc/.z-ai-config, que el
#     runtime de la plataforma re-inyecta con token/chatId frescos). Si un
#     token cambia, NO hay que reconfigurar nada: el bridge lo recarga por
#     mtime en cada petición.
#   • Idempotente: puedes ejecutarlo varias veces sin romper nada.
#   • Sin dependencias externas: node ≥ 18 (verificado aquí) y Claude Code
#     (instalado automáticamente si falta).
#
# Uso:
#   ./install.sh                    # instala todo (Claude Code incluido si falta)
#   ./install.sh --without-claude   # no tocar Claude Code (usar el existente)
#   ./install.sh --with-claude      # forzar (re)instalación/actualización de CC
#   ./install.sh --uninstall        # desinstalar shims y detener el bridge
# ============================================================================
set -eu

REPO_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${GLM_INSTALL_BIN:-$HOME/.local/bin}"
CLAUDE_PKG="@anthropic-ai/claude-code"

C_G="\033[1;32m"; C_Y="\033[1;33m"; C_R="\033[1;31m"; C_B="\033[1;36m"; C_0="\033[0m"
say()  { printf "%b\n" "${C_B}glm-claude-bridge${C_0}: $1"; }
ok()   { printf "%b\n" "  ${C_G}✓${C_0} $1"; }
warn() { printf "%b\n" "  ${C_Y}!${C_0} $1"; }
die()  { printf "%b\n" "  ${C_R}✗ $1${C_0}" >&2; exit 1; }

# ── desinstalación ──────────────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  say "desinstalando…"
  "$REPO_DIR/glm-bridge" stop >/dev/null 2>&1 || true
  rm -f "$BIN_DIR/glm-claude" "$BIN_DIR/glm-bridge"
  ok "shims eliminados de $BIN_DIR"
  ok "bridge detenido"
  say "listo. (los ficheros del repo en $REPO_DIR se conservan; bórralos a mano si quieres)"
  exit 0
fi

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║   GLM-CLAUDE-BRIDGE · instalación portable para sesiones z.ai    ║"
echo "║   Claude Code nativo ⇄ bridge local ⇄ mecanismo de TU sesión     ║"
echo "╚══════════════════════════════════════════════════════════════════╝"

# ── 1) detectar la sesión z.ai (dinámico, NUNCA hardcodeado) ────────────────
say "[1/5] detectando la sesión de chat.z.ai…"
CFG_PATH="${ZAI_CONFIG_PATH:-}"
[ -z "$CFG_PATH" ] && [ -f /etc/.z-ai-config ] && CFG_PATH=/etc/.z-ai-config
[ -z "$CFG_PATH" ] && [ -f "$HOME/.z-ai-config" ] && CFG_PATH="$HOME/.z-ai-config"
[ -z "$CFG_PATH" ] && [ -f "$REPO_DIR/.z-ai-config" ] && CFG_PATH="$REPO_DIR/.z-ai-config"
if [ -n "$CFG_PATH" ] && [ -f "$CFG_PATH" ]; then
  ok "fichero de nacimiento de la sesión: $CFG_PATH"
  node - "$CFG_PATH" <<'NODE' || die "el fichero de sesión existe pero no tiene baseUrl/apiKey válidos"
const fs = require('fs');
const c = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
if (!c.baseUrl || !c.apiKey) process.exit(1);
console.log(`    baseUrl=${c.baseUrl} | chatId=${c.chatId || '—'} | token=${c.token ? '(JWT presente, huella ...' + String(c.token).slice(-8) + ')' : 'ausente'}`);
NODE
  warn "las credenciales NO se copian ni se pegan en ningún sitio: el bridge las"
  warn "lee de este fichero en cada petición y se auto-recarga si la plataforma las rota."
else
  warn "NO se encontró /etc/.z-ai-config ni ZAI_CONFIG_PATH."
  warn "Esto NO parece una sesión de chat.z.ai (o el runtime aún no inyectó la identidad)."
  warn "Puedes instalar igualmente: cuando la sesión esté viva, el bridge tomará"
  warn "las credenciales automáticamente de /etc/.z-ai-config (o de \$ZAI_CONFIG_PATH)."
fi

# ── 2) node ──────────────────────────────────────────────────────────────────
say "[2/5] verificando node…"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
  ok "node $(node --version)"
  [ "$NODE_MAJOR" -ge 18 ] || die "se requiere node ≥ 18 (fetch/SSE). Instálalo y re-ejecuta."
else
  die "node no encontrado. Instala node ≥ 18 y re-ejecuta ./install.sh"
fi

# ── 3) permisos de los componentes ───────────────────────────────────────────
say "[3/5] preparando componentes del bridge…"
chmod +x "$REPO_DIR/bridge.mjs" "$REPO_DIR/glm-claude" "$REPO_DIR/glm-bridge" "$REPO_DIR/probe.mjs" 2>/dev/null || true
node --check "$REPO_DIR/bridge.mjs" && ok "bridge.mjs v4 (portable, session-born) sintaxis OK"
node --check "$REPO_DIR/translate.mjs" && ok "translate.mjs sintaxis OK"
node --check "$REPO_DIR/zai-config.mjs" && ok "zai-config.mjs (credenciales dinámicas con recarga) sintaxis OK"
bash -n "$REPO_DIR/glm-claude" && ok "glm-claude sintaxis OK"
bash -n "$REPO_DIR/glm-bridge" && ok "glm-bridge sintaxis OK"

# ── 4) Claude Code (auto-instalado si falta) ────────────────────────────────
say "[4/5] Claude Code…"
find_claude() {
  [ -n "${CLAUDE_BIN:-}" ] && [ -x "$CLAUDE_BIN" ] && { echo "$CLAUDE_BIN"; return 0; }
  command -v claude 2>/dev/null && return 0
  local p
  for p in "$HOME/.npm-global/bin/claude" "$HOME/.local/bin/claude" /usr/local/bin/claude /usr/bin/claude "$HOME/.claude/local/claude"; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}
install_claude() {
  say "instalando Claude Code ($CLAUDE_PKG) vía npm…"
  if npm install -g "$CLAUDE_PKG" >/dev/null 2>&1; then
    return 0
  fi
  warn "npm -g global falló (permisos). Reintentando con prefijo de usuario…"
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global" >/dev/null 2>&1 || true
  npm install -g "$CLAUDE_PKG" >/dev/null 2>&1 || {
    warn "npm falló; probando instalador nativo de Anthropic…"
    curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 || return 1
  }
  export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"
  return 0
}
case "${1:-}" in
  --without-claude)
    if CB="$(find_claude)"; then ok "Claude Code presente (según lo solicitado, sin tocar): $CB"
    else warn "Claude Code no encontrado; se omite su instalación (--without-claude)"; fi
    ;;
  --with-claude)
    install_claude || die "no se pudo instalar Claude Code automáticamente"
    CB="$(find_claude)" || die "Claude Code sigue sin estar disponible tras la instalación"
    ok "Claude Code instalado/actualizado: $CB ($("$CB" --version 2>/dev/null | head -1))"
    ;;
  "")
    if CB="$(find_claude)"; then
      ok "Claude Code ya presente: $CB ($("$CB" --version 2>/dev/null | head -1))"
    else
      warn "Claude Code no encontrado → instalando automáticamente…"
      install_claude || die "no se pudo instalar Claude Code (prueba: ./install.sh --with-claude o instala claude a mano)"
      CB="$(find_claude)" || die "Claude Code sigue sin estar disponible tras la instalación"
      ok "Claude Code instalado: $CB ($("$CB" --version 2>/dev/null | head -1))"
    fi
    ;;
  *)
    die "flag desconocido: $1 (usa --with-claude | --without-claude | --uninstall)"
    ;;
esac

# ── 5) shims globales (glm-claude / glm-bridge disponibles en PATH) ─────────
say "[5/5] instalando shims en $BIN_DIR…"
mkdir -p "$BIN_DIR"
ln -sf "$REPO_DIR/glm-claude" "$BIN_DIR/glm-claude"
ln -sf "$REPO_DIR/glm-bridge" "$BIN_DIR/glm-bridge"
ok "glm-claude  → $REPO_DIR/glm-claude"
ok "glm-bridge  → $REPO_DIR/glm-bridge"
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR ya está en PATH" ;;
  *)
    warn "$BIN_DIR NO está en PATH de esta shell"
    # idempotente: añadir a .bashrc/.profile solo si aún no está
    RC=""
    [ -f "$HOME/.bashrc" ] && RC="$HOME/.bashrc"
    [ -z "$RC" ] && [ -f "$HOME/.profile" ] && RC="$HOME/.profile"
    if [ -n "$RC" ] && ! grep -qs "glm-claude-bridge PATH" "$RC"; then
      printf '\n# glm-claude-bridge PATH\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$RC"
      ok "PATH añadido a $RC (abre una shell nueva o: export PATH=\"$BIN_DIR:\$PATH\")"
    else
      warn "añádelo a mano si quieres: export PATH=\"$BIN_DIR:\$PATH\""
    fi
    ;;
esac

# ── verificación final (sin gastar cuota) ───────────────────────────────────
say "verificación final (doctor)…"
export GLM_INSTALL_BIN="$BIN_DIR"
"$BIN_DIR/glm-bridge" doctor || true

# ── smoke test del bridge (arranque + health, 0 llamadas API) ───────────────
if "$BIN_DIR/glm-bridge" start >/dev/null 2>&1; then
  ok "bridge arrancado y saludable (usa: glm-bridge status | logs | probe)"
else
  warn "el bridge no arrancó ahora (se arrancará solo al invocar glm-claude). Revisa: glm-bridge start"
fi

echo
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  INSTALACIÓN COMPLETA — listo para trabajar de manera nativa     ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  glm-claude                  → Claude Code interactivo (REPL)    ║"
echo "║  glm-claude -p \"tarea\"       → modo no interactivo               ║"
echo "║  glm-claude --model NAME     → etiqueta de modelo de la sesión   ║"
echo "║  glm-bridge status|logs      → estado y logs del bridge          ║"
echo "║  glm-bridge doctor           → diagnóstico sin gastar cuota      ║"
echo "║  glm-bridge probe            → ¿qué modelo sirve el gateway?     ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo "Credenciales: resueltas dinámicamente de la sesión (recarga automática)."
echo "Si Z.ai rota el token/chatId/baseUrl, NO reconfiguras nada: el bridge se adapta."
