# FreeKimiAPI

Local **OpenAI/Anthropic-compatible API** for **Kimi Web Chat** (`kimi.ai`):
a zero-dependency Node.js server that drives the regular logged-in web session
from a separate Chrome profile.

> Experimental web-chat proxy. Kimi can change its internal API at any time.
> Use the official paid API for production workloads.

## Features

- `POST /v1/chat/completions` — OpenAI Chat Completions (stream + non-stream)
- `POST /v1/messages` — Anthropic Messages shim (Claude Code / Anthropic SDK)
- `POST /v1/responses` — OpenAI Responses API shim
- `GET /v1/models`, `GET /v1/model-capabilities` — aliases + real upstream mapping
- `GET /v1/sessions` — inspect active agent sessions
- `POST /reset-session?agent=<id|all>` — reset one agent or every session
- `GET /health`, `GET /readyz` — liveness and readiness probes
- `reasoning_content` for Kimi's thinking output
- **Tool calling** — OpenAI/Anthropic `tools` are injected into the prompt and
  the model's JSON tool request is converted back to `tool_calls` / `tool_use`
- **Multi-account pool** — comma-separated files or a directory of auth files;
  401/403/429 rotate the account with cooldowns
- **Session reuse** — continues the same Kimi chat (`chat_id` / `parent_id`) and
  sends only the new turn; bounded recovery prompts otherwise
- **Streaming** — SSE with keep-alives, idle timeout, request deadline and
  empty/rate-limit retries
- Optional proxy API key (`Authorization: Bearer` or `x-api-key`), loopback CORS
  by default, and multi-arch container/systemd files
- Zero npm dependencies (Node.js 18+; the Chrome auth helper needs Node 22+)

## Quick start

```bash
cp .env.example .env
npm run auth     # opens a separate Chrome window
npm start        # http://localhost:9657
```

`npm run auth`:

1. A dedicated Chrome window opens (profile `.chrome-for-testing-profile-kimi`).
2. Log in to Kimi in **that** window and send a short message (e.g. `ok`).
3. The helper writes `kimi-auth.json` and keeps watching: leave the window open
   and it rewrites the file whenever Kimi refreshes the access token.

Then:

```bash
curl http://localhost:9657/v1/models

curl http://localhost:9657/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"kimi-k2.5","messages":[{"role":"user","content":"Hello!"}]}'

curl -N http://localhost:9657/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"kimi-k2.5","stream":true,"user":"agent-1","messages":[{"role":"user","content":"Count to 5"}]}'
```

Anthropic clients (e.g. Claude Code):

```bash
export ANTHROPIC_BASE_URL=http://localhost:9657
export ANTHROPIC_API_KEY=local
export ANTHROPIC_MODEL=kimi-k2.5   # or kimi-k2.5-thinking
```

OpenAI Responses API:

```bash
curl http://localhost:9657/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"kimi-k2.5","input":"Explain SSE in one sentence."}'
```

### CLI client

```bash
npm run client -- "Explain WebSocket framing"
npm run client -- --model kimi-k2.5-thinking --think "Solve 12 × 37"
echo "Summarize this" | node client.js
```

The client talks to Kimi's gateway directly and reads the same auth file.

## Models

| Alias | Thinking | Web search | Notes |
| --- | --- | --- | --- |
| `kimi-k2.5` | env default | on | default |
| `kimi-k2.5-thinking` | on, high effort | on | reasoning |
| `kimi-k2.5-fast` | off | on | instant answers |
| `kimi-k2.5-search` | env default | on | explicit search alias |
| `kimi-k2.5-fast-search` | off | on | |
| `kimi-k2.5-thinking-search` | on, high | on | |
| `kimi-default`, `kimi`, `k28-instant` | env default | on | legacy aliases |

All aliases use `KIMI_MODEL` (default `k28-instant`). Unknown model names are
rejected with `400 invalid_model`; full capabilities are at
`GET /v1/model-capabilities`.

## Tool calling

Kimi's web protocol has no native OpenAI client-tool channel. The proxy injects
the tool schemas and a strict JSON contract:

```json
{"tool_call":{"name":"<function_name>","arguments":{...}}}
```

It parses that envelope (also `tool_calls`, `<tool_call>`, fenced JSON, and the
legacy `TOOL_CALL: name {…}` form), validates the name against the request's
tool list, and returns a proper OpenAI `tool_calls` turn, an Anthropic
`tool_use` block, or a Responses `function_call`. Tool results sent back as
`role: "tool"` / `tool_result` are replayed as `[Tool Result]` messages.

## Sessions

Kimi chats are stateful. The proxy keys a session by `x-agent-session`, then the
OpenAI `user` field / `session_id`, then the client IP (`dev-agent` locally).

- If the incoming history matches the previous turn, only the new messages are
  sent with Kimi's `chat_id` / `parent_id`.
- If the system prompt or tools changed, or the history diverged, a fresh Kimi
  chat receives the complete (bounded) prompt.
- Sessions rotate on TTL, message depth and remote character budget; idle
  entries are swept every 10 minutes.
- Send `/new` as the user message to reset an agent's session.

Prompt compaction is signalled with the `X-FreeKimi-Context-Compacted: 1`
response header.

## Multi-account pool

Any of these work:

```bash
KIMI_AUTH_PATH=./account-1.json,./account-2.json
KIMI_AUTH_DIR=./accounts        # every *.json in the directory
```

A single file may also embed several accounts:

```json
{ "accounts": [ { "name": "main", "token": "…", "cookie": "…" }, { "token": "…" } ] }
```

Accounts are sticky per session. On HTTP 401/403/429 the request is replayed on
another ready account and the failed one gets a cooldown. `/readyz` returns 503
when no account is serving, and `/health` shows per-account cooldowns.

## Images and files

Kimi's captured web protocol exposes no file-upload endpoint, so the proxy does
not upload images. Inline images and files are replaced by short markers
(`[Image attached; not visible through this proxy]`) so clients do not break and
base64 payloads never enter the prompt. `/v1/model-capabilities` reports
`vision: false` and `files: false`.

## Chrome profile

Two modes:

**Dedicated profile (recommended).** Leave `KIMI_CHROME_PROFILE` empty (or set it
to a directory the helper owns). `npm run auth` opens that profile; log in once
and keep the helper running.

**Existing Chrome profile.** Point at the profile folder directly:

```ini
KIMI_CHROME_PROFILE=C:\Users\Admin\AppData\Local\Google\Chrome\User Data\Profile 29
KIMI_KEEP_CHROME_PROFILE=1
```

or at the user-data-dir plus a profile name:

```ini
KIMI_CHROME_PROFILE=C:\Users\Admin\AppData\Local\Google\Chrome\User Data
KIMI_CHROME_PROFILE_DIRECTORY=Profile 29
KIMI_KEEP_CHROME_PROFILE=1
```

The helper never deletes an external profile. Close **all** Chrome windows first;
Chrome refuses to start a second debugging instance on a profile already in use.
Recent Chrome versions also block remote debugging on the *default* user data
directory — if the helper reports that DevTools did not start, use the extension
below (it works with your normal profile) or switch back to a dedicated profile.

## Chrome extension

`chrome-extension/` exports the same `kimi-auth.json` without the DevTools
helper:

1. Load it unpacked at `chrome://extensions`.
2. Open `kimi.ai`, log in and send one message.
3. Click **Refresh**, then **Download**.

It reads cookies, localStorage keys, and the live `Chat` request's
`Authorization` / `x-msh-shield-data` headers. The download folder is elsewhere,
so move the file next to `server.js` or point `KIMI_AUTH_PATH` at it.

## Auth file

`kimi-auth.json` is gitignored and written by the helper:

```json
{
  "token": "<access JWT>",
  "refreshToken": "<refresh token from localStorage>",
  "cookie": "theme=…; …",
  "shield": "sg:…",
  "deviceId": "…",
  "sessionId": "…",
  "trafficId": "…"
}
```

Import an existing session instead:

```bash
npm run auth:import -- --input ./chat.curl.txt   # Copy as cURL from DevTools
npm run auth:import -- --input ./kimi-auth.json
```

Kimi's web API has a browser-fingerprint header (`x-msh-shield-data`) that the
SPA regenerates per request. The helper captures the latest value; keep its
Chrome window open so the file stays fresh.

## Configuration

Copy `.env.example` to `.env`. Main variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `9657` | HTTP port |
| `HOST` | `127.0.0.1` | listen address |
| `PROXY_API_KEY` / `PROXY_API_KEY_FILE` | empty | optional proxy key |
| `REQUIRE_PROXY_API_KEY` | `0` | fail startup without a key |
| `PROXY_CORS_ORIGINS` | empty | extra browser origins |
| `KIMI_AUTH_PATH` / `KIMI_AUTH_DIR` | `./kimi-auth.json` | account source(s) |
| `KIMI_MODEL` | `k28-instant` | upstream model id |
| `KIMI_THINKING` | `1` | default thinking |
| `KIMI_SEARCH` | `1` | enable server-side web search |
| `KIMI_REASONING_EFFORT` | `REASONING_EFFORT_LOW` | low / medium / high |
| `KIMI_REQUEST_DEADLINE_MS` | `300000` | whole-request budget |
| `KIMI_MAX_PROMPT_CHARS` | `120000` | bounded upstream prompt |
| `KIMI_MAX_CONCURRENT` | `24` | in-flight request cap |
| `KIMI_ACCOUNT_COOLDOWN_MS` | `600000` | auth failure cooldown |
| `KIMI_RATE_LIMIT_COOLDOWN_MS` | `60000` | 429 cooldown |
| `KIMI_SESSION_TTL_MS` | `7200000` | remote chat rotation |
| `KIMI_MAX_MESSAGE_DEPTH` | `100` | messages per remote chat |
| `KIMI_CHROME_PORT` | `9335` | auth Chrome DevTools port |
| `KIMI_AUTH_WATCH` | `1` | keep refreshing the auth file |

## Deployment

```bash
# systemd
sudo cp deploy/free-kimi-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now free-kimi-api

# container (rootless Podman)
podman build -f Containerfile -t free-kimi-api .
podman run --rm -p 9657:9657 \
  -v "$PWD/kimi-auth.json:/run/secrets/kimi-auth.json:ro,Z" \
  -v "$PWD/proxy-api-key:/run/secrets/proxy-api-key:ro,Z" \
  free-kimi-api
```

When exposing the proxy beyond loopback, always set `PROXY_API_KEY`.

## Tests

```bash
npm test          # syntax checks + unit/integration/vision tests
```

Integration tests mock the Kimi gateway and cover streaming, sessions, tool
calls, Anthropic Messages, Responses and model validation.

## Troubleshooting

- **`401 unauthenticated`** — `npm run auth` again (and leave the window open).
- **429 / throttled** — account web limits; wait or add another account.
- **Empty answer** — the model spent its turn calling an internal skill; the
  proxy retries a bounded number of times.
- **Tool call not parsed** — retry; the proxy repairs malformed markup once and
  then returns `502 malformed_tool_call` instead of leaking markup as text.
- **`npm run doctor`** — local checks: Node version, auth file, token, cookies.
- **`npm run probe`** — direct upstream request without starting the proxy.

## Security

- `.gitignore` blocks `.env`, `kimi-auth.json`, account exports, `*.har`,
  `*.log`, cookies, proxy keys and Chrome profiles. Keep it that way.
- Never commit a real auth file or raw DevTools capture. If one was committed,
  re-run `npm run auth` to rotate the token and remove the file from history.
- Set `PROXY_API_KEY` whenever `HOST` is not loopback.
- Restrict the auth file on Unix: `chmod 600 kimi-auth.json`.

## Notes

- Multi-account pooling, tool calling and `/v1/responses` are implemented. Only
  image/file *upload* is unavailable because Kimi's captured protocol exposes no
  file endpoint; image parts become text markers.
- Use responsibly and in line with Kimi's terms of service.
