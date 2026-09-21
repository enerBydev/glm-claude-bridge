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

## Quick start — install in ANY chat.z.ai session

The bridge is a **portable, zero-config piece**: clone it in any chat.z.ai
session, run the installer, and Claude Code works natively with the session's
own birth mechanism. Nothing is hardcoded — credentials, baseUrl, chatId and
model are resolved **dynamically at runtime** and auto-reloaded when the
platform rotates them (mtime-based reload on every request).

```bash
# 1. In any chat.z.ai session (the runtime injects /etc/.z-ai-config there):
git clone https://github.com/enerBydev/glm-claude-bridge.git
cd glm-claude-bridge && ./install.sh

# 2. Work natively
glm-claude                      # interactive REPL (same UX as `claude`)
glm-claude -p "refactor this"   # non-interactive
glm-claude --model glm-5.3-flash -p "hi"   # session model label
glm-bridge doctor               # full preflight, zero API quota used
glm-bridge probe                # what model does the gateway REALLY serve?
```

What `install.sh` does (idempotent, safe to re-run):

1. **Detects the z.ai session** (`/etc/.z-ai-config` → `$ZAI_CONFIG_PATH` →
   `~/.z-ai-config` → `./.z-ai-config`) and shows the session identity
   (chatId + token fingerprint — never the token itself).
2. **Verifies node ≥ 18**.
3. **Syntax-checks every bridge component** (fails fast on a broken download).
4. **Installs Claude Code automatically** if missing (`npm i -g
   @anthropic-ai/claude-code`, with user-prefix and native-installer
   fallbacks). Flags: `--without-claude` (skip), `--with-claude` (force update).
5. **Installs `glm-claude` / `glm-bridge` shims** into `~/.local/bin` (and
   fixes PATH in `~/.bashrc` if needed).
6. **Runs `glm-bridge doctor`** + a bridge smoke test (0 API calls used).

Uninstall: `./install.sh --uninstall`.

### Why nothing needs reconfiguring

The session's identity lives in the platform-injected file
`/etc/.z-ai-config` (`baseUrl`, `apiKey`, session JWT `token`, `chatId`,
`userId`, optional `model`). The bridge **never copies that data anywhere**:
a config provider re-reads the file on mtime change and rebuilds upstream
headers **per request** — and since v4 the upstream URL and model are also
resolved per request. If Z.ai rotates the token mid-session, the next request
already uses the fresh one. No re-edits, no restarts, no secrets in git.

## QA — automated, offline, zero quota

```bash
./qa.sh            # full suite (6 stages)
./qa.sh --fast     # syntax + unit tests + smokes only
```

`qa.sh` runs the **entire quality gate without a real gateway and without
spending a single API call** — it works in development, in CI (GitHub Actions
or any other), and after installing in a fresh session:

1. **Syntax** — `node --check` on all modules + `bash -n` + executable bits.
2. **Unit tests** — 37 translation-layer assertions.
3. **Smokes** — credential loader fails clearly with no session
   (`GLM_QA_HIDE_SESSION=1` testability seam); StreamTranslator emits a valid
   Anthropic SSE sequence.
4. **Hermetic installer preflight** — runs `install.sh --without-claude` inside
   a temporary `$HOME` with no session and no credentials; verifies the shims
   are created and the absence of a session is warned, not fatal.
5. **E2E against a mock gateway** (`tests/mock-upstream.mjs`, deterministic) —
   14 scenarios through the REAL bridge process: message round-trip, model
   mapping, tool calling (JSON arguments), thinking blocks, synthetic SSE
   streaming, `count_tokens`, vision routing, **live credential rotation**
   (new token used on the very next request, no restart), **live baseUrl
   rotation** (v4), fail-fast 429 when daily quota is 0 (exactly ONE upstream
   attempt), 401 mapping and post-failure recovery.
6. **Doctor** against the live session (informational).

The mock gateway also supports failure modes (`always-429`, `auth-required`)
and full request capture (`/__mock/requests`) for asserting exactly what the
bridge sends — headers included.

## Manual setup (without the installer)

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
| `glm-claude` | Starts the bridge if needed, exports the full Claude Code env (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, model mapping, telemetry off), then `exec claude "$@"`. Supports `glm-claude --model <label>` to set the session model label |
| `glm-bridge` | `start \| stop \| restart \| status \| logs [n] \| follow \| health \| probe \| doctor` — `probe` live-verifies which model the gateway actually serves; `doctor` runs the full preflight without spending API quota |

## Repository layout

```
install.sh          Portable installer for any chat.z.ai session (idempotent, --uninstall supported)
bridge.mjs          HTTP server: routing, SSE pump, retries, logging (logs the gateway's real model echo)
translate.mjs       Pure Anthropic⇄GLM translation + streaming state machine
zai-config.mjs      Credential provider (.z-ai-config, mtime auto-reload) + upstream headers
probe.mjs           Live probe: which model does the gateway really serve?
glm-bridge          Control CLI (start/stop/status/logs/health/probe/doctor)
glm-claude          One-command launcher for Claude Code (--model supported, dynamic claude resolution)
scripts/debug-sse.mjs   Upstream SSE probe (raw bytes + parser simulation)
tests/test-translate.mjs  37 unit tests for the translation layer
.github/workflows/ci.yml  CI: syntax checks + tests across Node 20/22/24
README.es.md        Documentación en español
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GLM_MODEL` | `glm-5.3-flash` | Model **label**. Precedence (v4): `GLM_MODEL` env → `model` field in the session file → this default. Non-`glm-*` requested models are mapped to the resolved session model; `glm-*` labels are forwarded verbatim |
| `GLM_BRIDGE_PORT` / `GLM_BRIDGE_HOST` | `8787` / `127.0.0.1` | Bridge listen address |
| `GLM_THINKING` | `0` | `1` enables upstream thinking (reasoning deltas are still not forwarded) |
| `GLM_BRIDGE_TOOL_HINT` | on | Appends a system note that forbids tool-name localization |
| `GLM_BRIDGE_RETRIES` | `4` | Retries on 403/429/5xx (backoff + jitter) |
| `GLM_BRIDGE_TOKEN` | empty | If set, requires this token on bridge requests |
| `GLM_BRIDGE_IDLE_MS` | `300000` | Upstream idle watchdog |
| `GLM_BRIDGE_DEBUG` | `0` | Verbose chunk logging |
| `ZAI_CONFIG_PATH` | auto | Override credential file location (`/etc/.z-ai-config` → `~/.z-ai-config` → `./.z-ai-config`) |
| `GLM_INSTALL_BIN` | `~/.local/bin` | Where `install.sh` places the `glm-claude` / `glm-bridge` shims |
| `CLAUDE_BIN` | auto | Explicit path to the `claude` binary (auto-resolved: PATH → npm-global → ~/.local/bin → system dirs) |

### Environment the launcher sets for Claude Code

`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
`ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`,
`MAX_THINKING_TOKENS=0`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS=128000`,
`CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY`,
`DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `API_TIMEOUT_MS=600000`.

## Which model actually runs? (evidence-based)

Fair question: "is glm-5.3-flash really running behind the scenes?" A full
forensic investigation (SDK dissection, sandbox forensics, API surface
mapping, behavioral fingerprinting) says:

1. **The `model` field has zero observable effect.** In 6/6 controlled tests
   the gateway answered identically to `glm-5.3-flash`, a made-up name,
   `claude-sonnet-4-5`, and **no `model` field at all** — always echoing the
   static label `glm-4-plus`.
2. **Z.ai's own SDK never sends `model` for chat** (`z-ai-web-dev-sdk`): even
   the official client doesn't choose a model — the gateway decides
   server-side. The only named-model request in the whole ecosystem is
   `glm-4.6v`, on the vision endpoint.
3. **The GLM/Zhipu family is confirmed behaviorally**: with no system prompt
   the model self-identifies as GLM / Zhipu AI 100% of the time; error codes
   and messages match Zhipu's BigModel stack. The *exact generation* stays
   uncertain because single cutoff probes are noisy (the same backend both
   knew and didn't know DeepSeek-R1 on different runs).
4. **There is no observable way to select a model with this credential**: no
   `/v1/models`, no name validation, no name-based routing. Observable routing
   is per-endpoint only (`/chat/completions/vision` serves a different class,
   echoing `glm-5v-turbo`).
5. **Real quotas** (exposed via `x-ratelimit-*` headers): 2 QPS,
   30 requests / 10 min and 300 / day per bucket — size your agentic usage
   accordingly.

**Practical takeaway**: `GLM_MODEL` / `--model` configure the *label* Claude
Code sees and requests (forwarded verbatim, so it future-proofs you if the
gateway ever routes by name), but the served model today is Z.ai's default.
Whatever Claude Code *says* it is, is not evidence — its system prompt tells
it "you are Claude" and the underlying model parrots that. Run
`glm-bridge probe` any time to see what the gateway declares and a live
behavioral reading.

## v3 — session-born credentials (the 2026-09-21 discovery)

Deep sandbox forensics (`/start.sh`, the workspace runtime, the Z.ai SDK
source) found where the agent's tool calls are really born:

- `/start.sh` writes a base `{"baseUrl": "...", "apiKey": "Z.ai"}` to
  `/etc/.z-ai-config` — **`Z.ai` is a literal, not a secret**; auth is the
  container's network identity.
- The workspace runtime then injects the **session identity** into the same
  file: `chatId` (this conversation's id), `userId` and a **JWT `token`**
  (HS256, payload `{user_id, chat_id, platform: "zai"}`).
- The official SDK sends that identity on every call: `X-Chat-Id`,
  `X-User-Id`, `X-Token` (plus `Authorization: Bearer Z.ai`, `X-Z-AI-From: Z`).
- **The gateway now enforces it**: requests without `X-Token` get
  `401 {"error":"missing X-Token header"}`. The session identity also opens a
  **separate user-level quota bucket** (200/day, 30/10 min) beside the
  key-level one (300/day).

Therefore bridge **v3**:

1. **Credentials are reloaded by `mtime`** — when the platform re-injects the
   token (every new conversation / continuation), the bridge picks it up on
   the next request instead of going stale (the root cause of mysterious 401s
   in v2 after a session refresh).
2. **`429` fail-fast** when a daily bucket is at 0 — blind retries only burn
   the user-level bucket (each 429 decrements it).
3. **Thinking support**: honors `thinking: {type:'enabled'}` from Claude Code
   (or `GLM_THINKING=1`), maps upstream `reasoning_content` to Anthropic
   `thinking` blocks (with `thinking_delta` / `signature_delta` in streams),
   in the right position (thinking → text → tool_use).
4. **/health exposes the session binding** (chatId, token fingerprint,
   config mtime) and the last-seen quota buckets.

`glm-claude` still targets the bridge transparently; nothing to configure —
the bridge is literally born from the same `/etc/.z-ai-config` mechanism the
host session uses.

## Hard-won implementation notes

1. **`X-Z-AI-From: Z` is mandatory** on this gateway; requests without it get
   an empty 403. The bridge always sends it.
2. **The gateway ignores the `model` field** (see the section above): the
   bridge still forwards `glm-*` names verbatim and logs the gateway's real
   echo on every request (`eco gateway model=...` in logs,
   `gateway_echo_model` in `/health`).
3. **Aggressive rate limiting** — bursts of requests trigger empty 403s. The
   retry layer absorbs them transparently.
4. **Tool-name localization defense** — the gateway was observed rewriting
   `get_weather` to `Obtener clima`. Countermeasures: system hint + resolver
   (exact → normalized → containment → single-offered → token overlap) and a
   safe degrade-to-text path so Claude Code never sees an invalid `tool_use`.
5. **Node 24 fetch chunks are `Uint8Array`**, not `Buffer` — `.toString()`
   yields comma-joined byte codes. The bridge decodes with `TextDecoder`
   (`stream: true`) so multi-byte UTF-8 split across chunks is safe.
6. **`req.on('close')` fires when the request body has been read**, not when
   the client disconnects — listen on `res.on('close')` + `writableEnded`.
7. **`claude -p` without a TTY waits for stdin EOF** — redirect
   `< /dev/null` in scripts (interactive terminals are unaffected).
8. **Images are only accepted on `/chat/completions/vision`** (plain
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
