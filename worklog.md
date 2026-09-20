# Worklog

---
Task ID: verify-model-1
Agent: Super Z (principal)
Task: Verificar/confirmar si Claude Code realmente usa glm-5.3-flash a través del GLM-Bridge

Work Log:
- Entorno se había reiniciado: reinstalado @anthropic-ai/claude-code 2.1.278 (npm global), recreados symlinks glm-bridge/glm-claude en ~/.npm-global/bin
- Arrancado GLM-Bridge (pid verificado, health OK en 127.0.0.1:8787)
- scripts/verify-model.sh: llamadas DIRECTAS al gateway (internal-api.z.ai) con cabeceras completas (Authorization, X-Z-AI-From: Z, X-Token, X-Chat-Id, X-User-Id) probando model=glm-5.3-flash, modelo-falso-xyz, claude-sonnet-4-5 → TODAS responden, eco del gateway SIEMPRE "glm-4-plus"; usage idéntico (posible caché)
- scripts/fingerprint-model.sh: fingerprinting con prompts únicos (nonce anti-caché) → 4/4 el modelo se autoidentifica como GLM / Zhipu AI (nunca Claude ni GPT)
- E2E con Claude Code oficial: `glm-claude -p "¿qué modelo eres?"` → CC emite warning [claude-code:unrecognized_model] {"model":"glm-5.3-flash"} y el modelo responde "Soy Claude/Anthropic" (contaminación del system prompt de CC: no es evidencia fiable)
- Log del bridge confirma la cadena: CC → POST /v1/messages | modelo_up=glm-5.3-flash | tools=20 | in=12960 out=17 | OK stream 2025ms

Stage Summary:
- HALLAZGO CLAVE: el gateway de Z.ai IGNORA el campo `model` solicitado (acepta incluso nombres falsos) y el eco de respuesta es siempre "glm-4-plus". NO es verificable desde fuera que el modelo servido sea exactamente "glm-5.3-flash"; la etiqueta es cosmética a nivel de gateway.
- SÍ verificado: Claude Code oficial 2.1.278 funciona a través del bridge; el modelo subyacente es de la familia GLM (Zhipu AI) según autoidentificación sin system prompt (4/4).
- La autoidentificación A TRAVÉS de Claude Code no es fiable (el system prompt de CC dice "eres Claude Code/Claude" y el modelo lo repite).
- Scripts de verificación reutilizables: /home/z/my-project/scripts/verify-model.sh y fingerprint-model.sh
- Implicación para el bridge: la traducción de protocolo es correcta y funciona; la incertidumbre de versión del modelo es una limitación del gateway (opaco), no del bridge. El bridge ya reenvía nombres glm-* literalmente, así que si el gateway algún día valida/rutea por modelo, se respetará.
