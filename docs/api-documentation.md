# FreeKimiAPI — API documentation

Base URL: `http://127.0.0.1:9657` (configurable with `HOST` / `PORT`).

Authentication is optional. When `PROXY_API_KEY` is set, send either:

```
Authorization: Bearer <key>
x-api-key: <key>
```

`/`, `/health` and `/readyz` are always public.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness + account/model/session status |
| GET | `/readyz` | 200 when at least one account is usable, else 503 |
| GET | `/v1/models` | OpenAI-compatible model list |
| GET | `/v1/model-capabilities` (`/api/...`) | full alias → upstream mapping |
| GET | `/v1/sessions` | list agent sessions |
| POST | `/reset-session?agent=<id>` | reset one agent's Kimi chat |
| POST | `/reset-session?agent=all` | reset every session |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1/responses` | OpenAI Responses |

## Chat Completions

```json
{
  "model": "kimi-k2.5",
  "user": "agent-1",
  "stream": false,
  "messages": [
    { "role": "system", "content": "Be concise." },
    { "role": "user", "content": "Hello" }
  ],
  "tools": [
    { "type": "function", "function": { "name": "get_weather", "parameters": { "type": "object", "properties": { "city": { "type": "string" } } } } }
  ]
}
```

Non-stream response:

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "kimi-k2.5",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello!", "reasoning_content": "…" },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 34,
    "total_tokens": 46,
    "completion_tokens_details": { "reasoning_tokens": 20 }
  },
  "watermark": "t.me/forgetmeai"
}
```

Streaming uses standard `chat.completion.chunk` events and ends with
`data: [DONE]`. When tools are supplied the answer is buffered (keep-alives are
sent) so a tool turn is emitted atomically:

```json
{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_…","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"NY\"}"}}]},"finish_reason":null}]}
```

`finish_reason` is `tool_calls` for tool turns and `length` when Kimi reports a
truncated answer (currently uncommon on the web path).

### Sessions

Session key precedence: `x-agent-session` header → `user` → `session_id` → client
IP (`dev-agent` locally). A matching message-history prefix reuses the remote
Kimi chat and sends only the new turn; otherwise a fresh chat receives the full
bounded transcript. Send `/new` as the latest user message to reset.

## Anthropic Messages

`system` (string or blocks), `messages`, `tools` (`name` / `description` /
`input_schema`) and `stream` are supported. Responses use Anthropic shapes:

- non-stream: `content: [{ "type": "text", "text": "…" }]`,
  `reasoning_content` when thinking is present
- tool turn: `content: [{ "type": "tool_use", "id": "…", "name": "…", "input": {…} }]`
  with `stop_reason: "tool_use"`
- stream: `message_start`, `content_block_*`, `message_delta`, `message_stop`

`tool_result` blocks in user messages are converted back to `[Tool Result]`
prompt text.

## Responses API

Input may be a string, a message array, or Responses items (`message`,
`function_call`, `function_call_output`, `input_text`). Output:

- `object: "response"` with `output_text` and `output`
- reasoning as a `reasoning` item, text as an `output_text` item, tools as
  `function_call` items
- streaming: `response.created`, `response.in_progress`,
  `response.output_item.*`, `response.output_text.*`,
  `response.function_call_arguments.*`, `response.completed`, then `[DONE]`

## Errors

Errors use the client's protocol shape:

```json
{ "error": { "message": "…", "type": "invalid_request_error", "code": 400 } }
```

Streaming failures after headers are sent become SSE `error` events (and an
OpenAI `data: [DONE]` terminator). Relevant statuses:

| Status | Type | Meaning |
| --- | --- | --- |
| 400 | `invalid_request_error` | bad JSON / empty messages |
| 400 | `invalid_model` | unknown model alias |
| 400 | `context_length_exceeded` | prompt still too long after compaction |
| 401 | `authentication_error` | bad proxy key or expired Kimi session |
| 405/404 | `not_found` | unsupported path |
| 413 | `payload_too_large` | body over `KIMI_MAX_BODY_BYTES` |
| 429 | `rate_limit` | account cooldown / Kimi throttling |
| 502 | `upstream_error`, `empty_response`, `malformed_tool_call` | Kimi-side failure |
| 503 | `no_auth`, `overloaded` | no account ready or concurrency cap |
| 504 | `request_timeout` | request deadline exceeded |

## Model capabilities

`GET /v1/model-capabilities` returns every alias with `real_model`,
`upstream_model`, `thinking_enabled`, `search_enabled`, `capabilities`
(`reasoning`, `web_search`, `files`, `vision`, `tool_calls`), `supported`,
`deprecated` and `unavailable_reason`.

`files` and `vision` are `false`: Kimi's captured web protocol has no upload
endpoint, so image parts are replaced by text markers.
