# GLM-Bridge — Claude Code oficial sobre GLM

Solución original a medida que hace funcionar el **Claude Code oficial de Anthropic**
(paquete npm `@anthropic-ai/claude-code`, sin forks ni repos de terceros) sobre el
gateway GLM de Z.ai, reutilizando **el mismo token** que usa el agente de esta sesión.

## Instalación portable en CUALQUIER sesión de chat.z.ai

El bridge es una **pieza portable de cero configuración**: clónalo en cualquier
sesión de chat.z.ai, ejecuta el instalador, y Claude Code funciona de manera
nativa con el mecanismo de nacimiento de ESA sesión. **Nada va hardcodeado** —
credenciales, baseUrl, chatId y modelo se resuelven **dinámicamente en tiempo de
ejecución** y se auto-recargan cuando la plataforma los rota (recarga por mtime
en cada petición).

```bash
# 1. En cualquier sesión de chat.z.ai (el runtime inyecta allí /etc/.z-ai-config):
git clone https://github.com/enerBydev/glm-claude-bridge.git
cd glm-claude-bridge && ./install.sh

# 2. Trabaja de manera nativa
glm-claude                      # REPL interactivo (misma UX que `claude`)
glm-claude -p "haz algo"        # modo no interactivo
glm-claude --model glm-5.3-flash -p "hola"  # etiqueta de modelo de la sesión
glm-bridge doctor               # diagnóstico completo, 0 cuota de API
glm-bridge probe                # ¿qué modelo sirve REALMENTE el gateway?
```

Qué hace `install.sh` (idempotente, seguro de re-ejecutar):

1. **Detecta la sesión z.ai** (`/etc/.z-ai-config` → `$ZAI_CONFIG_PATH` →
   `~/.z-ai-config` → `./.z-ai-config`) y muestra la identidad de la sesión
   (chatId + huella del token — nunca el token completo).
2. **Verifica node ≥ 18**.
3. **Verifica la sintaxis de cada componente** (falla rápido ante una descarga rota).
4. **Instala Claude Code automáticamente** si falta (`npm i -g
   @anthropic-ai/claude-code`, con fallbacks de prefijo de usuario e instalador
   nativo). Flags: `--without-claude` (omitir), `--with-claude` (forzar actualización).
5. **Instala los shims `glm-claude` / `glm-bridge`** en `~/.local/bin` (y corrige
   el PATH en `~/.bashrc` si hace falta).
6. **Ejecuta `glm-bridge doctor`** + smoke test del bridge (0 llamadas de API).

Desinstalar: `./install.sh --uninstall`.

### Por qué no hay que reconfigurar nunca nada

La identidad de la sesión vive en el fichero inyectado por la plataforma
`/etc/.z-ai-config` (`baseUrl`, `apiKey`, JWT de sesión `token`, `chatId`,
`userId`, y opcionalmente `model`). El bridge **nunca copia esos datos a ningún
sitio**: un proveedor de configuración relee el fichero cuando cambia su mtime y
reconstruye las cabeceras upstream **por petición** — y desde la v4 la URL
upstream y el modelo también se resuelven por petición. Si Z.ai rota el token a
media sesión, la siguiente petición ya usa el nuevo. Sin re-edits, sin
reinicios, sin secretos en git.

## Arquitectura

```
┌──────────────┐  API Anthropic   ┌──────────────────────┐  API OpenAI/GLM   ┌──────────────────┐
│ Claude Code  │ ───────────────▶ │   GLM-Bridge         │ ────────────────▶ │ internal-api.z.ai│
│   oficial    │ ◀─────────────── │  (Node 24, 0 deps)   │ ◀──────────────── │  (token del      │
└──────────────┘  /v1/messages    └──────────────────────┘ /chat/completions └── agente)────────┘
   127.0.0.1:8787 · traduce streaming SSE, tool calling, visión, usage
```

El bridge expone la API de Messages de Anthropic y traduce en tiempo real:

- **Streaming SSE**: chunks `chat.completion.chunk` (estilo OpenAI) → eventos
  `message_start` / `content_block_start` / `content_block_delta` / `content_block_stop`
  / `message_delta` / `message_stop` (estilo Anthropic), incluidos
  `input_json_delta` para argumentos de herramientas en streaming.
- **Tool calling**: `tools`/`tool_choice`/`tool_use`/`tool_result` con resolución
  de nombres (el gateway a veces traduce los nombres de herramientas; el bridge
  los mapea de vuelta y añade un hint de sistema que lo impide en la fuente).
- **No-streaming** y fallback si el upstream decide streamear sin pedírselo.
- **count_tokens** con estimador local (CJK ~1 token/char, resto ~4 chars/token).
- **Visión**: bloques `image` base64 → `image_url` data-URI.
- **Robustez**: reintentos con backoff exponencial+jitter ante 403/429/5xx del
  gateway (que aplica rate-limiting agresivo), watchdog de inactividad,
  `max_tokens` clampeado a 32768, abort limpio si el cliente se desconecta.

## Uso rápido

```bash
glm-claude                      # REPL interactivo (equivale a `claude`)
glm-claude -p "haz algo"        # modo no interativo
glm-claude --resume             # continuar sesión
glm-claude --model glm-x -p ... # etiqueta de modelo para esta sesión (ver abajo)
```

Los shims los instala `install.sh` en `~/.local/bin` (configurable con `GLM_INSTALL_BIN`).

## Control del bridge

```bash
glm-bridge start | stop | restart | status | logs [n] | follow | health | probe | doctor
```

`glm-bridge doctor` verifica el entorno completo de una sesión fresca (node,
fichero de sesión, Claude Code, shims en PATH, bridge) SIN gastar cuota de API.

`glm-bridge probe` verifica en vivo qué modelo sirve realmente el gateway
(2 llamadas API): eco declarado + sonda conductual de cutoff.

## Ficheros

| Fichero | Papel |
|---|---|
| `install.sh` | Instalador portable para cualquier sesión z.ai (idempotente, soporta `--uninstall`) |
| `bridge.mjs` | Servidor HTTP, routing, SSE pump, reintentos, logging (incluye eco del gateway) |
| `translate.mjs` | Traducción pura Anthropic⇄GLM + máquina de estados de streaming |
| `zai-config.mjs` | Proveedor de credenciales (`.z-ai-config`, recarga por mtime) y cabeceras upstream |
| `probe.mjs` | Sonda de verificación del modelo real (eco + cutoff conductual) |
| `glm-bridge` | CLI de control (start/stop/status/logs/**probe**/**doctor**) |
| `glm-claude` | Lanzador: resuelve claude dinámicamente, arranca bridge, exporta env, `exec claude` (soporta `--model`) |
| `logs/` | `server.out` (log vivo) y `bridge-YYYY-MM-DD.log` (por día) — ignorado por git |

## Variables de entorno

| Variable | Defecto | Descripción |
|---|---|---|
| `GLM_MODEL` | `glm-5.3-flash` | Etiqueta de modelo. Precedencia (v4): env `GLM_MODEL` → campo `model` del fichero de sesión → este defecto (los `glm-*` pedidos pasan tal cual; el resto se mapea al resuelto) |
| `GLM_BRIDGE_PORT` / `GLM_BRIDGE_HOST` | `8787` / `127.0.0.1` | Escucha del bridge |
| `GLM_THINKING` | `0` | `1` activa thinking upstream (reasoning_content se traduce a bloques thinking de Anthropic) |
| `GLM_BRIDGE_TOOL_HINT` | on (`!=0`) | Hint anti-traducción de nombres de herramientas |
| `GLM_BRIDGE_RETRIES` | `4` | Reintentos ante 403/429/5xx |
| `GLM_BRIDGE_TOKEN` | vacío | Si se define, exige auth en el bridge |
| `GLM_BRIDGE_IDLE_MS` | `300000` | Watchdog de inactividad del upstream |
| `GLM_BRIDGE_DEBUG` | `0` | Log verboso de chunks del stream |
| `ZAI_CONFIG_PATH` | auto | Override de la ruta del `.z-ai-config` |

El lanzador `glm-claude` exporta además el entorno correcto para Claude Code
(`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
`ANTHROPIC_DEFAULT_*_MODEL`, telemetría off, `MAX_THINKING_TOKENS=0`,
`CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`,
`CLAUDE_CODE_MAX_CONTEXT_TOKENS=128000`).

## Notas y hallazgos del reverse-engineering

1. **`X-Z-AI-From: Z` es obligatorio** en el gateway: sin esa cabecera responde
   403 vacío (fue la causa de los primeros fallos). El bridge la envía siempre.
2. **El gateway IGNORA el campo `model`** (ver sección siguiente): acepta
   nombres válidos, falsos o ausentes y sirve siempre su default. El bridge
   reenvía `glm-*` tal cual y registra en cada petición el eco real
   (`eco gateway model=...` en logs y `gateway_echo_model` en `/health`).
3. Rate-limiting agresivo: peticiones rápidas encadenadas → 403. El backoff
   del bridge lo absorbe de forma transparente.
4. El gateway llegó a devolver un nombre de herramienta traducido
   (`get_weather` → `Obtener clima`). Defensas: hint de sistema + resolución
   por exacto/normalizado/contención/única-ofrecida/tokens, y degradación a
   texto si no hay match (Claude Code nunca ve un `tool_use` inválido).
5. En Node 24, los chunks de `fetch.body` son `Uint8Array`, no `Buffer`:
   `.toString()` produce códigos de byte separados por comas. El bridge usa
   `TextDecoder` con `stream: true` (UTF-8 multibyte seguro entre chunks).
6. `claude -p` en contextos sin TTY espera EOF de stdin: redirigir con
   `< /dev/null` en scripts (en terminal interactivo no afecta).

## ¿Qué modelo corre realmente? (investigación con evidencia)

Pregunta legítima: «¿de verdad corre glm-5.3-flash detrás?». Investigación
forense completa (SDK, entorno, superficie API, fingerprint conductual):

1. **El campo `model` no tiene ningún efecto observable.** En 6/6 tests el
   gateway respondió idéntico pidiendo `glm-5.3-flash`, `modelo-falso-xyz`,
   `claude-sonnet-4-5` o **sin campo `model`** (eco estático: `glm-4-plus`).
2. **El SDK oficial de Z.ai (`z-ai-web-dev-sdk`) nunca envía `model`** en chat:
   el cliente oficial tampoco elige modelo — el gateway decide server-side.
3. **Familia confirmada por conducta**: sin system prompt el modelo se
   autoidentifica como GLM/Zhipu AI en el 100% de los casos; el stack es
   Zhipu BigModel (errores con código 1210, mensajes en chino). La generación
   exacta es incierta por sampling (sondas de cutoff contradictorias entre
   ejecuciones: conoció e ignoró DeepSeek-R1 en días distintos).
4. **No hay manera observable de elegir modelo con esta credencial**: sin
   `/v1/models`, sin validación de nombres, sin routing por nombre. El ruteo
   observable solo existe por endpoint (`/chat/completions/vision` sirve otra
   clase de modelo, eco `glm-5v-turbo`).
5. **Cuotas reales** (exponen los headers `x-ratelimit-*`): 2 QPS,
   30 peticiones/10 min y 300/día por bucket — dimensiona el uso agéntico.

**Conclusión práctica**: `GLM_MODEL` / `--model` configuran la *etiqueta* que
Claude Code ve y pide (y que el bridge reenviará literal si el gateway algún
día ruteara por nombre), pero el modelo servido hoy lo decide Z.ai. La sonda
`glm-bridge probe` permite verificar en vivo lo que el gateway declara y
muestra. Las respuestas de Claude Code sobre su identidad NO son evidencia:
el system prompt de CC le dice "eres Claude" y el modelo lo repite.

## v3 — credenciales session-born (descubrimiento del 2026-09-21)

La forense profunda del sandbox (`/start.sh`, runtime del workspace, código
fuente del SDK) encontró de dónde nacen realmente las llamadas del agente:

- `/start.sh` escribe la config base `{"baseUrl": "...", "apiKey": "Z.ai"}`
  en `/etc/.z-ai-config` — **`Z.ai` es un literal, no un secreto**; la
  autenticación real es la identidad de red del contenedor.
- El runtime del workspace luego inyecta en ese mismo fichero la **identidad
  de sesión**: `chatId` (el id de ESTA conversación), `userId` y un **JWT
  `token`** (HS256, payload `{user_id, chat_id, platform: "zai"}`).
- El SDK oficial envía esa identidad en cada llamada: `X-Chat-Id`,
  `X-User-Id`, `X-Token` (junto a `Authorization: Bearer Z.ai` y
  `X-Z-AI-From: Z`).
- **El gateway ahora lo exige**: sin `X-Token` responde
  `401 {"error":"missing X-Token header"}`. La identidad de sesión abre
  además un **bucket de cuota user-level separado** (200/día, 30/10 min)
  junto al key-level (300/día).

Por eso el bridge **v3**:

1. **Recarga credenciales por `mtime`** — cuando la plataforma re-inyecta el
   token (cada nueva conversación/continuación), el bridge lo recoge en la
   siguiente petición en vez de quedarse obsoleto (causa raíz de los 401
   misteriosos de la v2 tras un refresco de sesión).
2. **Fail-fast en `429`** con bucket daily a 0 — reintentar a ciegas sólo
   quema el bucket user (cada 429 lo descuenta).
3. **Soporte de thinking**: honra `thinking: {type:'enabled'}` de Claude Code
   (o `GLM_THINKING=1`) y mapea `reasoning_content` del upstream a bloques
   `thinking` de Anthropic (con `thinking_delta`/`signature_delta` en
   streams), en la posición correcta (thinking → text → tool_use).
4. **/health expone el binding de sesión** (chatId, huella del token, mtime
   del config) y los buckets de cuota vistos por última vez.

`glm-claude` sigue apuntando al bridge de forma transparente; nada que
configurar — el bridge nace literalmente del mismo mecanismo
`/etc/.z-ai-config` que la sesión anfitriona.

## Verificación realizada

- 37 tests unitarios de traducción (`tests/test-translate.mjs`, incluye v3 thinking): OK
- No-streaming, streaming SSE, count_tokens: OK
- Bucle agéntico completo con 20 herramientas: Write + Read + Bash OK
  (el modelo creó ficheros, los leyó y reportó contenido real)
- Arranque en frío vía `glm-claude` (bridge on-demand): OK
- Ciclo `glm-bridge start/stop/restart/status/probe` vía symlinks: OK
- Eco real del gateway registrado en logs y `/health`: OK
