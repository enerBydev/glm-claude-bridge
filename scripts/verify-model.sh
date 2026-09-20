#!/usr/bin/env bash
# ============================================================================
# verify-model.sh — Verificación forense de qué modelo atiende realmente
# las peticiones (nivel upstream, sin pasar por Claude Code).
# Incluye experimento de control: nombres de modelo falsos DEBEN fallar
# si el gateway valida el campo model de verdad.
# ============================================================================
set -eu
CFG=/etc/.z-ai-config
read -r API_KEY TOKEN CHAT_ID USER_ID URL <<< "$(python3 -c "
import json
d=json.load(open('$CFG'))
print(d['apiKey'], d.get('token',''), d.get('chatId',''), d.get('userId',''), d['baseUrl']+'/chat/completions')
")"

call_upstream() {
  local model="$1"
  echo "── TEST: model=\"$model\""
  curl -s -m 60 "$URL" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -H "X-Z-AI-From: Z" \
    -H "X-Token: $TOKEN" \
    -H "X-Chat-Id: $CHAT_ID" \
    -H "X-User-Id: $USER_ID" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Responde exactamente una palabra: ping\"}],\"max_tokens\":32,\"stream\":false}" \
  | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception as e:
    print('   respuesta no-JSON:', e); sys.exit()
if 'error' in d:
    print('   ERROR gateway:', json.dumps(d['error'], ensure_ascii=False)[:200])
elif 'choices' in d:
    print('   campo model (eco del gateway):', d.get('model'))
    print('   texto:', repr(d['choices'][0]['message']['content'][:80]))
    print('   usage:', d.get('usage'))
else:
    print('   respuesta inesperada:', json.dumps(d)[:200])
"
  echo
}

call_upstream "glm-5.3-flash"
call_upstream "modelo-falso-que-no-existe-xyz"
call_upstream "claude-sonnet-4-5-20250929"
