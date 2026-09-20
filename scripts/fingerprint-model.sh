#!/usr/bin/env bash
# ============================================================================
# fingerprint-model.sh — Identificación conductual del modelo real.
# Preguntas de identidad con prompts únicos (evita caché) + variación de
# nombres de modelo para ver si el eco del gateway cambia.
# ============================================================================
set -eu
read -r API_KEY TOKEN CHAT_ID USER_ID URL <<< "$(python3 -c "
import json
d=json.load(open('/etc/.z-ai-config'))
print(d['apiKey'], d.get('token',''), d.get('chatId',''), d.get('userId',''), d['baseUrl']+'/chat/completions')
")"

NONCE=$RANDOM

ask() {
  local model="$1" prompt="$2" label="$3"
  echo "── $label (model=\"$model\")"
  local body
  body=$(python3 -c "
import json,sys
print(json.dumps({
  'model': sys.argv[1],
  'messages': [{'role':'user','content': sys.argv[2]}],
  'max_tokens': 150, 'stream': False
}))" "$model" "$prompt")
  curl -s -m 90 "$URL" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -H "X-Z-AI-From: Z" \
    -H "X-Token: $TOKEN" \
    -H "X-Chat-Id: $CHAT_ID" \
    -H "X-User-Id: $USER_ID" \
    -d "$body" \
  | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception as e: print('   no-JSON:', e); sys.exit()
if 'error' in d: print('   ERROR:', json.dumps(d['error'], ensure_ascii=False)[:150])
elif 'choices' in d:
    print('   eco model:', d.get('model'))
    print('   responde :', repr(d['choices'][0]['message']['content'][:220]))
    print('   usage    :', d.get('usage'))
"
  echo
}

Q1="Pregunta de identidad (nonce $NONCE): ¿Cuál es exactamente tu nombre de modelo? ¿Quién es tu desarrollador? ¿Eres Claude, GPT, GLM u otro? Responde en una sola línea clara."
Q2="Nonce $NONCE-b: ¿Qué modelo de lenguaje eres? Menciona tu familia y versión si la conoces. Una línea."

ask "glm-5.3-flash"   "$Q1" "TEST 1: identidad, nombre solicitado glm-5.3-flash"
ask "gpt-4o"          "$Q2" "TEST 2: identidad, nombre solicitado gpt-4o (control)"
ask "glm-4.6"         "$Q1" "TEST 3: identidad, nombre solicitado glm-4.6"
ask "glm-4.5-air"     "$Q2" "TEST 4: identidad, nombre solicitado glm-4.5-air"
