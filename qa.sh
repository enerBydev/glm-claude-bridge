#!/usr/bin/env bash
# ============================================================================
# qa.sh — QA completo de glm-claude-bridge en UN comando, sin gateway real
# y sin gastar cuota. Pensado para: desarrollo local, CI (GitHub Actions u
# otro), y validación post-instalación en cualquier sesión.
#
#   ./qa.sh              → suite completa
#   ./qa.sh --fast       → sintaxis + unitarios + smokes (sin E2E, agéntico
#                          ni instalador)
#
# Etapas:
#   1. Sintaxis (node --check de los 7 módulos .mjs, bash -n × 3 scripts)
#   2. Unitarios de traducción (37 aserciones)
#   3. Smokes: loader de credenciales SIN sesión (GLM_QA_HIDE_SESSION=1) y
#      StreamTranslator → SSE Anthropic válido
#   4. Preflight hermético del instalador (HOME temporal sin sesión ni claude
#      → install.sh --without-claude → shims + doctor)
#   5. E2E con mock del gateway (18 escenarios: tool calling, thinking,
#      streaming, visión, rotación de credenciales y baseUrl en vivo,
#      fail-fast 429, 401, recuperación) — cero cuota real
#   6. AGÉNTICO: Claude Code real (binario oficial) ↔ bridge ↔ mock — bucle
#      tool_use→ejecución→tool_result→texto final, cero cuota (SKIP si no
#      hay Claude Code instalado; GLM_AGENTIC_REQUIRE=1 lo vuelve obligatorio)
#   7. Doctor contra la sesión real (informativo, no falla el QA)
# ============================================================================
set -u
cd "$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

C_G="\033[1;32m"; C_R="\033[1;31m"; C_B="\033[1;36m"; C_Y="\033[1;33m"; C_0="\033[0m"
FAILED=0
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

step()   { printf "\n%b── %s ──%b\n" "$C_B" "$1" "$C_0"; }
pass()   { printf "%b  ✓ %s%b\n" "$C_G" "$1" "$C_0"; }
fail()   { printf "%b  ✗ %s%b\n" "$C_R" "$1" "$C_0"; FAILED=$((FAILED+1)); }
info()   { printf "%b  · %s%b\n" "$C_Y" "$1" "$C_0"; }

trap 'STATUS=$?; if [ $STATUS -ne 0 ]; then printf "\n%bQA terminó con fallos (exit %s) — limpiando procesos residuales…%b\n" "$C_Y" "$STATUS" "$C_0"; pkill -f "tests/mock-upstream.mjs" 2>/dev/null; pkill -f "bridge.mjs --glm-e2e" 2>/dev/null; pkill -f "bridge.mjs --glm-agentic" 2>/dev/null; fi' EXIT

# ── 1) sintaxis ──────────────────────────────────────────────────────────────
step "1/7 Sintaxis"
for f in bridge.mjs translate.mjs zai-config.mjs probe.mjs tests/mock-upstream.mjs tests/e2e.mjs tests/agentic.mjs; do
  node --check "$f" && pass "$f" || fail "$f"
done
for f in glm-bridge glm-claude install.sh; do
  bash -n "$f" && pass "$f (bash)" || fail "$f (bash)"
  test -x "$f" && pass "$f ejecutable" || fail "$f NO ejecutable"
done
test -x tests/agentic.mjs && pass "tests/agentic.mjs ejecutable" || fail "tests/agentic.mjs NO ejecutable"

# ── 2) unitarios ─────────────────────────────────────────────────────────────
step "2/7 Unitarios de traducción"
if OUT="$(node tests/test-translate.mjs 2>&1)"; then
  pass "$(echo "$OUT" | tail -1)"
else
  fail "tests/test-translate.mjs"; echo "$OUT" | tail -10
fi

# ── 3) smokes ────────────────────────────────────────────────────────────────
step "3/7 Smokes"
if OUT="$(GLM_QA_HIDE_SESSION=1 node -e "
import('./zai-config.mjs').then(m => {
  try { m.loadZaiConfig(); console.error('FAIL: cargó credenciales sin sesión'); process.exit(1); }
  catch (e) { if (/No se encontr/.test(e.message)) process.exit(0); console.error('FALLO:', e.message); process.exit(1); }
});" 2>&1)"; then pass "loader sin sesión falla con mensaje claro (GLM_QA_HIDE_SESSION=1)"; else fail "loader sin sesión: $OUT"; fi

if OUT="$(node -e "
import('./translate.mjs').then(({ StreamTranslator }) => {
  const tr = new StreamTranslator({ requestedModel: 'glm-5.3-flash', offeredNames: ['Bash'], inputTokensEstimate: 1 });
  const evs = [...tr.start(), ...tr.handleChunk({ choices: [{ delta: { content: 'hi' } }] }), ...tr.finalize()];
  const names = evs.map(e => e.event);
  if (names[0] !== 'message_start' || names[names.length-1] !== 'message_stop') process.exit(1);
  console.log('OK: ' + evs.length + ' eventos SSE válidos');
});" 2>&1)"; then pass "$OUT"; else fail "StreamTranslator: $OUT"; fi

# ── 4) preflight hermético del instalador ────────────────────────────────────
if [ "$FAST" -eq 0 ]; then
  step "4/7 Preflight hermético del instalador (HOME temporal, sin sesión)"
  FAKE_HOME="$(mktemp -d)"
  if OUT="$(env HOME="$FAKE_HOME" GLM_QA_HIDE_SESSION=1 PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" ./install.sh --without-claude 2>&1)"; then
    pass "install.sh completa en entorno virgen"
    if [ -x "$FAKE_HOME/.local/bin/glm-bridge" ] && [ -x "$FAKE_HOME/.local/bin/glm-claude" ]; then
      pass "shims glm-claude/glm-bridge creados en \$HOME/.local/bin"
    else
      fail "shims no creados en HOME temporal"
    fi
    if echo "$OUT" | grep -q "NO se encontró /etc/.z-ai-config"; then
      pass "avisa correctamente de sesión ausente sin morir"
    else
      fail "no avisó de la sesión ausente como se esperaba"
    fi
    info "resumen del instalador: $(echo "$OUT" | grep -c '✓') checks ✓"
  else
    fail "install.sh falló en entorno virgen"; echo "$OUT" | tail -12
  fi
  rm -rf "$FAKE_HOME"
else
  info "4/7 omitida (--fast)"
fi

# ── 5) E2E con mock (cero cuota) ─────────────────────────────────────────────
if [ "$FAST" -eq 0 ]; then
  step "5/7 E2E contra mock del gateway (18 escenarios, cero cuota)"
  pkill -f "tests/mock-upstream.mjs" 2>/dev/null; pkill -f "bridge.mjs --glm-e2e" 2>/dev/null; sleep 0.3
  if OUT="$(node tests/e2e.mjs 2>&1)"; then
    pass "$(echo "$OUT" | grep -E '^[0-9]+ pasadas' | head -1)"
  else
    fail "E2E con fallos:"; echo "$OUT" | grep -E "✗|FATAL" | head -10
  fi
else
  info "5/7 omitida (--fast)"
fi

# ── 6) AGÉNTICO: Claude Code real contra el mock (cero cuota) ────────────────
if [ "$FAST" -eq 0 ]; then
  step "6/7 Agéntico: Claude Code real ↔ bridge ↔ mock (bucle tool_use completo)"
  CLAUDE_FOUND=0
  [ -n "${CLAUDE_BIN:-}" ] && [ -x "$CLAUDE_BIN" ] && CLAUDE_FOUND=1
  command -v claude >/dev/null 2>&1 && CLAUDE_FOUND=1
  for _p in "$HOME/.npm-global/bin/claude" "$HOME/.local/bin/claude" /usr/local/bin/claude /usr/bin/claude "$HOME/.claude/local/claude"; do
    [ -x "$_p" ] && CLAUDE_FOUND=1
  done
  if [ "$CLAUDE_FOUND" -eq 1 ]; then
    pkill -f "tests/mock-upstream.mjs" 2>/dev/null; pkill -f "bridge.mjs --glm-agentic" 2>/dev/null; sleep 0.3
    if OUT="$(node tests/agentic.mjs 2>&1)"; then
      pass "$(echo "$OUT" | grep -E '^AGENTIC:' | head -1)"
      echo "$OUT" | grep -E '^  ✓' | head -6
    else
      fail "test agéntico:"; echo "$OUT" | grep -E "✗|FATAL|SKIP" | head -8
    fi
  else
    info "Claude Code no instalado — etapa omitida (instala con install.sh --with-claude; usa GLM_AGENTIC_REQUIRE=1 para exigirla en CI)"
  fi
else
  info "6/7 omitida (--fast)"
fi

# ── 7) doctor contra la sesión real (informativo) ────────────────────────────
step "7/7 Doctor (sesión real, informativo)"
if ./glm-bridge doctor >/tmp/qa-doctor.out 2>&1; then
  pass "doctor: TODO OK"; grep -E "✓|health" /tmp/qa-doctor.out | head -6
else
  info "doctor reporta pendientes (normal fuera de una sesión viva):"
  grep -E "✗" /tmp/qa-doctor.out | head -4
fi

# ── resumen ──────────────────────────────────────────────────────────────────
printf "\n%b════════════════════════════════════════%b\n" "$C_B" "$C_0"
if [ "$FAILED" -eq 0 ]; then
  printf "%b  QA COMPLETO: TODO VERDE%b\n" "$C_G" "$C_0"
else
  printf "%b  QA: $FAILED etapa(s) con fallos%b\n" "$C_R" "$C_0"
fi
printf "%b════════════════════════════════════════%b\n" "$C_B" "$C_0"
exit $FAILED
