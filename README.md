# AgentBridge

AgentBridge is a lightweight API gateway for local AI coding agents.

It adapts provider SDKs and CLIs behind one HTTP/SSE surface. It does not manage workflows or multi-agent orchestration.

## Development

```bash
npm install
npm run start:dev
```

Default server: `http://127.0.0.1:8787`

Browser CORS is disabled by default because this gateway can invoke local agents
against local working directories. To allow browser clients, set explicit origins:

```bash
CORS_ORIGINS=http://localhost:3000 npm run start:dev
```

## API

- `GET /health`
- `GET /ready`
- `GET /providers`
- `POST /invoke`
- `POST /invoke/async`
- `GET /invoke/:requestId`
- `POST /cancel`
- `POST /stream` Server-Sent Events

`GET /providers` caches CLI detection results to keep client startup fast. When
the cache expires, the endpoint returns the last snapshot immediately and starts
a background refresh. The next request receives the updated provider state.
Configure the TTL with `PROVIDER_DETECTION_TTL_MS` (default: `30000`).

### Invoke

Start a new provider session:

```json
POST /invoke
{
  "provider": "codex",
  "cwd": "C:\\Users\\xman\\github\\agent-bridge",
  "input": "Reply with exactly: pong"
}
```

The response includes a bridge request id, provider id, final assistant text, and the provider session id when available:

```json
{
  "requestId": "inv_...",
  "provider": "codex",
  "session": "019e...",
  "finalText": "pong"
}
```

Resume the same native provider session by passing `session` from the previous response:

```json
POST /invoke
{
  "provider": "codex",
  "cwd": "C:\\Users\\xman\\github\\agent-bridge",
  "session": "019e...",
  "input": "Continue the previous task"
}
```

`requestId` identifies one bridge invocation. `session` is the value to persist if the caller wants resume behavior.

`nativeOptions` is an experimental provider-specific escape hatch. Prefer the
stable top-level fields (`provider`, `cwd`, `input`, `model`, `session`) unless a
provider adapter explicitly documents an option.

### Async Invoke and Cancel

`POST /invoke` waits for the provider to finish. Use `POST /invoke/async` when
the caller needs a cancellable request id before completion:

```json
POST /invoke/async
{
  "provider": "codex",
  "cwd": "C:\\Users\\xman\\github\\agent-bridge",
  "input": "Start a long task"
}
```

Response:

```json
{
  "requestId": "inv_...",
  "provider": "codex",
  "status": "running"
}
```

Check status:

```text
GET /invoke/inv_...
```

Cancel an active async invoke or stream:

```json
POST /cancel
{
  "requestId": "inv_..."
}
```

### Stream

`POST /stream` returns Server-Sent Events. The first event is always `started`
so callers can capture the cancellable `requestId` before provider output begins:

```text
event: started
data: {"type":"started","requestId":"inv_...","provider":"codex","timestamp":"..."}
```

Provider output then follows as `message`, `tool_call`, `tool_result`, `stdout`,
`stderr`, `done`, or `error` events. The stream ends after `done` or `error`.

### Errors

HTTP errors use one envelope:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Request validation failed.",
    "retryable": false,
    "details": {}
  }
}
```

Provider stream errors are sent as SSE `error` events with the same `error`
object shape.

### Smoke

Run smoke checks after building:

```bash
npm run build
npm run smoke -- --http-only --timeout-ms 10000
```

## Provider Status

- Codex: implemented for invoke, stream, cancel, local image input, and native session resume.
- Gemini: implemented through the Gemini CLI for string input, stream, cancel, and native session resume.
- Claude: implemented through the Claude Agent SDK for string input, stream, cancel, and native session resume.
