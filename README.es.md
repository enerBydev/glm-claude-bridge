# GLM-Bridge — Claude Code oficial sobre GLM

Solución original a medida que hace funcionar el **Claude Code oficial de Anthropic**
(paquete npm `@anthropic-ai/claude-code`, sin forks ni repos de terceros) sobre el
gateway GLM de Z.ai, reutilizando **el mismo token** que usa el agente de esta sesión.

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
```

Los symlinks están en `~/.npm-global/bin/` (ya en el PATH).

## Control del bridge

```bash
glm-bridge start | stop | restart | status | logs [n] | follow | health
```

## Ficheros

| Fichero | Papel |
|---|---|
| `bridge.mjs` | Servidor HTTP, routing, SSE pump, reintentos, logging |
| `translate.mjs` | Traducción pura Anthropic⇄GLM + máquina de estados de streaming |
| `zai-config.mjs` | Carga de credenciales (`.z-ai-config`) y cabeceras upstream |
| `glm-bridge` | CLI de control (start/stop/status/logs) |
| `glm-claude` | Lanzador: arranca bridge, exporta env, `exec claude` |
| `logs/` | `server.out` (log vivo) y `bridge-YYYY-MM-DD.log` (por día) |

## Variables de entorno

| Variable | Defecto | Descripción |
|---|---|---|
| `GLM_MODEL` | `glm-5.3-flash` | Modelo upstream (los `glm-*` pedidos pasan tal cual; el resto se mapea a este) |
| `GLM_BRIDGE_PORT` / `GLM_BRIDGE_HOST` | `8787` / `127.0.0.1` | Escucha del bridge |
| `GLM_THINKING` | `0` | `1` activa thinking upstream (deltas `reasoning_content` se ignoran de todos modos) |
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
2. El gateway reporta el modelo que sirve con su alias interno; el nombre
   pedido se respeta como passthrough.
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

## Verificación realizada

- 26 tests unitarios de traducción (`scripts/test-translate.mjs`): OK
- No-streaming, streaming SSE, count_tokens: OK
- Bucle agéntico completo con 20 herramientas: Write + Read + Bash OK
  (el modelo creó ficheros, los leyó y reportó contenido real)
- Arranque en frío vía `glm-claude` (bridge on-demand): OK
- Ciclo `glm-bridge start/stop/restart/status` vía symlinks: OK
