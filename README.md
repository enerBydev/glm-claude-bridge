# GLM-Bridge

[![CI](https://github.com/enerBydev/glm-claude-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/enerBydev/glm-claude-bridge/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen?logo=node.js)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-linux%20%7C%20macos-lightgrey)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#)

**Run the official Claude Code CLI on GLM models** through a purpose-built local
bridge that speaks Anthropic's Messages API on one side and GLM's
OpenAI-compatible API on the other. No forks, no third-party routers — the
official `@anthropic-ai/claude-code` npm package plus ~1,300 lines of original,
dependency-free Node.js.

```
┌──────────────┐  Anthropic API   ┌──────────────────────┐  OpenAI/GLM API   ┌────────────────┐
│ Claude Code  │ ───────────────▶ │     GLM-Bridge       │ ────────────────▶ │  GLM gateway   │
│  (official)  │ ◀─────────────── │  (Node 24, zero deps)│ ◀──────────────── │ (your Z.ai     │
└──────────────┘  /v1/messages    └──────────────────────┘ /chat/completions └── credentials)──┘
                 http://127.0.0.1:8787
```

## Highlights

- **Official Claude Code, unmodified** — installed from npm, driven by env vars.
- **Full streaming translation** — OpenAI-style `chat.completion.chunk` SSE is
  re-emitted as native Anthropic events (`message_start`, `content_block_*`,
  `input_json_delta`, `message_delta`, `message_stop`).
- **Complete tool calling** — `tools`, `tool_choice`, `tool_use`, `tool_result`,
  parallel calls, and streamed JSON arguments, with a **tool-name resolver**
  that survives gateways which localize tool names (yes, that happens).
- **Agentic loop verified** — Write / Read / Bash / Glob / Grep / Edit round
  trips tested end-to-end against the real CLI.
- **Token counting** — local `count_tokens` estimator (CJK-aware) so Claude
  Code's context management works.
- **Vision passthrough** — base64 image blocks become `image_url` data URIs.
- **Production hardening** — exponential backoff with jitter on 403/429/5xx,
  idle watchdog, clean client-disconnect handling, `max_tokens` clamping.

## Quick start

```bash
# 1. Configure your Z.ai credentials (never committed, gitignored)
sudo cp your-z-ai-config.json /etc/.z-ai-config
#    shape: { "baseUrl": "https://<host>/v1", "apiKey": "...", "token": "...", "chatId": "...", "userId": "..." }

# 2. Install the official CLI + link the launchers
npm install -g @anthropic-ai/claude-code
ln -sf "$(pwd)/glm-claude" ~/.local/bin/glm-claude
ln -sf "$(pwd)/glm-bridge" ~/.local/bin/glm-bridge

# 3. Go
glm-claude                      # interactive REPL (same UX as `claude`)
glm-claude -p "refactor this"   # non-interactive
glm-bridge status               # bridge health / logs
```

## What the launchers do

| Script | Purpose |
|---|---|
| `glm-claude` | Starts the bridge if needed, exports the full Claude Code env (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, model mapping, telemetry off), then `exec claude "$@"` |
| `glm-bridge` | `start \| stop \| restart \| status \| logs [n] \| follow \| health` |

## Repository layout

```
bridge.mjs          HTTP server: routing, SSE pump, retries, logging
translate.mjs       Pure Anthropic⇄GLM translation + streaming state machine
zai-config.mjs      Credential loader (.z-ai-config) + upstream headers
glm-bridge          Control CLI (start/stop/status/logs/health)
glm-claude          One-command launcher for Claude Code
scripts/debug-sse.mjs   Upstream SSE probe (raw bytes + parser simulation)
tests/test-translate.mjs  26 unit tests for the translation layer
.github/workflows/ci.yml  CI: syntax checks + tests across Node 20/22/24
README.es.md        Documentación en español
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GLM_MODEL` | `glm-5.3-flash` | Upstream model. Non-`glm-*` requested models are mapped to it |
| `GLM_BRIDGE_PORT` / `GLM_BRIDGE_HOST` | `8787` / `127.0.0.1` | Bridge listen address |
| `GLM_THINKING` | `0` | `1` enables upstream thinking (reasoning deltas are still not forwarded) |
| `GLM_BRIDGE_TOOL_HINT` | on | Appends a system note that forbids tool-name localization |
| `GLM_BRIDGE_RETRIES` | `4` | Retries on 403/429/5xx (backoff + jitter) |
| `GLM_BRIDGE_TOKEN` | empty | If set, requires this token on bridge requests |
| `GLM_BRIDGE_IDLE_MS` | `300000` | Upstream idle watchdog |
| `GLM_BRIDGE_DEBUG` | `0` | Verbose chunk logging |
| `ZAI_CONFIG_PATH` | auto | Override credential file location (`/etc/.z-ai-config` → `~/.z-ai-config` → `./.z-ai-config`) |

### Environment the launcher sets for Claude Code

`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
`ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`,
`MAX_THINKING_TOKENS=0`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS=128000`,
`CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY`,
`DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `API_TIMEOUT_MS=600000`.

## Hard-won implementation notes

1. **`X-Z-AI-From: Z` is mandatory** on this gateway; requests without it get
   an empty 403. The bridge always sends it.
2. **Aggressive rate limiting** — bursts of requests trigger empty 403s. The
   retry layer absorbs them transparently.
3. **Tool-name localization defense** — the gateway was observed rewriting
   `get_weather` to `Obtener clima`. Countermeasures: system hint + resolver
   (exact → normalized → containment → single-offered → token overlap) and a
   safe degrade-to-text path so Claude Code never sees an invalid `tool_use`.
4. **Node 24 fetch chunks are `Uint8Array`**, not `Buffer` — `.toString()`
   yields comma-joined byte codes. The bridge decodes with `TextDecoder`
   (`stream: true`) so multi-byte UTF-8 split across chunks is safe.
5. **`req.on('close')` fires when the request body has been read**, not when
   the client disconnects — listen on `res.on('close')` + `writableEnded`.
6. **`claude -p` without a TTY waits for stdin EOF** — redirect
   `< /dev/null` in scripts (interactive terminals are unaffected).
7. **Images are only accepted on `/chat/completions/vision`** (plain
   `/chat/completions` returns 400 for image parts). The bridge detects image
   blocks and routes those requests automatically.

## Tested compatibility matrix

| Claude Code feature | Status |
|---|---|
| Interactive REPL / `-p` one-shot | ✅ |
| Streaming output | ✅ |
| Tool loop: Write, Read, Bash, Glob, Grep, Edit | ✅ |
| `--output-format json` / `stream-json` | ✅ |
| Session `--continue` / `--resume` | ✅ |
| `--append-system-prompt`, `--model` | ✅ |
| Subagents (Task tool) | ✅ |
| Image reading (vision) — auto-routed to `/chat/completions/vision` | ✅ |
| Permission modes (`--permission-mode plan`) | ✅ |
| WebFetch (client-side fetch + model summary) | ✅ |
| Web search via server-side tools | ⚠️ not available on GLM gateway |
| Extended thinking blocks | ⚠️ disabled by design (unsigned blocks unsupported) |

## CI note

The workflow (`.github/workflows/ci.yml`) is syntax-checked and every step
passes in a clean clone (Node 20/22/24). If runs fail within seconds with no
steps executed on a **private** repo, it is the account's Actions billing /
spending limit, not the code: fix it under *Settings → Billing and plans*
(verify payment method / raise the spending limit), or make the repository
public, where Actions are free.

## License

MIT — see [LICENSE](LICENSE).
