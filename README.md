# AgentBridge

AgentBridge is a lightweight provider proxy for local AI coding agents.

It exposes local provider SDKs and CLIs over HTTP/SSE while preserving provider
behavior. It does not manage workflows or multi-agent orchestration.

## Development

### Prerequisites

- Node.js 22 or newer.
- At least one supported local agent installed and authenticated:
  - Codex: `codex --version` and `codex login status` should pass.
  - Claude: `claude --version` and `claude auth status` should pass.
  - Gemini: credentials must be available to `@google/gemini-cli-core`.

Copy `.env.example` to `.env` only when you want to override optional settings
such as host, port, workspace location, provider detection cache, or browser
CORS origins.

```bash
npm install
npm run start:dev
```

Default server: `http://127.0.0.1:8787`

`WORKSPACE` is optional and defaults to `~/.agent-bridge` when unset. Requests
select a relative `project`, and the bridge starts the agent in
`${WORKSPACE}/projects/${project}`.
Set `WORKSPACE` only if you want a different base directory. If
`WORKSPACE=C:\Users\xman\.agent-bridge`, use `"project": "agent-bridge"` to run
an agent in `C:\Users\xman\.agent-bridge\projects\agent-bridge`.

`project` is enforced for the provider working directory. Absolute paths and
`..` escapes are rejected, and provider options cannot override the bridge-owned
working directory fields. Because AgentBridge defaults providers to
auto-approval/yolo mode, `project` is not a hard operating-system sandbox: a
provider that can execute shell commands may still touch absolute paths outside
the project unless the provider's own sandboxing is configured to prevent it.

Check the service before invoking an agent:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/providers
```

Browser CORS is disabled by default because this gateway can invoke local agents
against local working directories. To allow browser clients, set explicit origins:

```bash
CORS_ORIGINS=http://localhost:3000 npm run start:dev
```

## API

- `GET /health`
- `GET /ready`
- `GET /providers`
- `GET /providers/:provider`
- `POST /invoke`
- `POST /runs`
- `GET /runs/:id`
- `GET /runs/:id/events`
- `DELETE /runs/:id`

Legacy compatibility endpoints:

- `POST /invoke/async`
- `GET /invoke/:rid`
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
  "project": "agent-bridge",
  "input": "Reply with exactly: pong"
}
```

The response includes a bridge rid, provider id, final assistant output, and the provider session id when available:

```json
{
  "rid": "018bcfe5-6800-7a3f-9c2d-4b6f9a1e2c30",
  "provider": "codex",
  "session": "019e...",
  "output": "pong"
}
```

Resume the same native provider session by passing `session` from the previous response:

```json
POST /invoke
{
  "provider": "codex",
  "project": "agent-bridge",
  "session": "019e...",
  "input": "Continue the previous task"
}
```

`rid` identifies one bridge invocation. It is an unprefixed UUIDv7, so ids sort
by creation time. `session` is the value to persist if the caller wants resume
behavior.

Request fields:

| Field | Required | Description |
| --- | --- | --- |
| `provider` | Yes | One of `codex`, `claude`, or `gemini`. |
| `input` | Yes | A string, or an array of content parts. Arrays support `{ "type": "text", "text": "..." }` and `{ "type": "local_image", "path": "..." }`. Local image input is Codex-only. |
| `project` | No | Relative subdirectory under `${WORKSPACE}/projects`. Defaults to `.`. Absolute paths and `..` escapes are rejected. |
| `model` | No | Provider model override. |
| `session` | No | Native provider session id from a previous response. |
| `metadata` | No | Caller metadata. The bridge accepts it but does not interpret it. |

`options` is an experimental provider-specific escape hatch. Prefer the
stable top-level fields (`provider`, `project`, `input`, `model`, `session`) unless a
provider adapter explicitly documents an option.

Known `options` keys:

| Provider | Keys |
| --- | --- |
| Codex | `codexOptions`, `threadOptions`, `turnOptions` |
| Claude | `claudeOptions` |
| Gemini | `geminiAuthType`, `geminiApiKey`, `geminiBaseUrl`, `geminiCustomHeaders`, `geminiConfig` |

AgentBridge defaults provider calls to non-interactive auto-approval mode so
remote API calls do not block on local approval prompts:

| Provider | Default mapping |
| --- | --- |
| Codex | `threadOptions.approvalPolicy = "never"` and `threadOptions.sandboxMode = "danger-full-access"` |
| Claude | `claudeOptions.permissionMode = "bypassPermissions"` and `claudeOptions.allowDangerouslySkipPermissions = true` |
| Gemini | `geminiConfig.approvalMode = "yolo"`, `disableYoloMode = false`, `trustedFolder = true`, and `interactive = false` |

Provider-specific options are applied after these defaults, so callers can still
override the mode for a specific request.

### Runs

Use runs for asynchronous provider execution. A run continues after the HTTP
request that created it returns. Subscribe to its events separately with SSE.
This avoids restarting a provider when an SSE client reconnects.

Create a run:

```json
POST /runs
{
  "provider": "codex",
  "project": "agent-bridge",
  "input": "Start a long task"
}
```

Response:

```json
{
  "id": "018bcfe5-6800-7a3f-9c2d-4b6f9a1e2c30",
  "provider": "codex",
  "status": "running",
  "createdAt": "...",
  "updatedAt": "...",
  "eventsUrl": "/runs/018bcfe5-6800-7a3f-9c2d-4b6f9a1e2c30/events"
}
```

Check status:

```text
GET /runs/018bcfe5-6800-7a3f-9c2d-4b6f9a1e2c30
```

Subscribe to events:

```text
GET /runs/018bcfe5-6800-7a3f-9c2d-4b6f9a1e2c30/events
Accept: text/event-stream
```

Run event streams replay AgentBridge's buffered provider events. Each event has
a monotonic SSE id. Reconnect with `Last-Event-ID` to resume from the next
buffered event without starting the provider again:

```text
Last-Event-ID: 12
```

Provider output is sent as `event` events with the provider event object in
`data`. Completion and errors are sent as `done` or `error`.

Cancel a run:

```text
DELETE /runs/018bcfe5-6800-7a3f-9c2d-4b6f9a1e2c30
```

Run statuses are `running`, `cancelling`, `completed`, `failed`, or
`cancelled`.

### Legacy Async Invoke and Cancel

`POST /invoke` waits for the provider to finish. Use `POST /invoke/async` when
the caller needs a cancellable request id before completion. New callers should
prefer `POST /runs`.

```json
POST /invoke/async
{
  "provider": "codex",
  "project": "agent-bridge",
  "input": "Start a long task"
}
```

Response:

```json
{
  "rid": "018bcfe5-6800-7a3f-9c2d-4b6f9a1e2c30",
  "provider": "codex",
  "status": "running"
}
```

Check status:

```text
GET /invoke/018bcfe5-6800-7a3f-9c2d-4b6f9a1e2c30
```

Cancel an active async invoke or stream:

```json
POST /cancel
{
  "rid": "018bcfe5-6800-7a3f-9c2d-4b6f9a1e2c30"
}
```

### Legacy Stream

`POST /stream` returns Server-Sent Events. The first event is always `started`
so callers can capture the cancellable `rid` before provider output begins:

```text
event: started
data: {"type":"started","rid":"018bcfe5-6800-7a3f-9c2d-4b6f9a1e2c30","provider":"codex","timestamp":"..."}
```

Provider output then follows as `event` events containing provider-native
payloads, followed by `done` or `error`. The stream ends after `done` or
`error`.
New callers that need reconnectable streams should create a run and subscribe to
`GET /runs/:id/events`.

### Session Safety

Provider sessions are native and non-transactional. `session` in a request means
"resume this native provider session"; `session` in a response is the session id
callers should use next.

Cancellation is best-effort. If a realtime call such as `POST /invoke` or legacy
`POST /stream` is interrupted after a native session has been supplied, the
provider session may contain partial state. Runs reduce disconnect-related
session pollution because execution is not tied to the SSE subscription, but
they cannot roll back provider-side failures or partial writes.

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
npm run smoke
# HTTP-only checks:
npm run smoke -- -- --http-only
```

The HTTP-only command intentionally has two `--` separators: the first forwards
arguments through `npm`, and the second is passed to the smoke script.

Live smoke uses a local smoke workspace by default:
`smoke/workspace/projects/<current-folder>`. The runner prepares that project
and passes the matching `WORKSPACE` to the server it starts. To test a different
project, pass both values explicitly:

```bash
npm run smoke -- -- --workspace C:\Users\xman\.agent-bridge --project agent-bridge
```

When smoke targets a server that is already running, start that server with the
same `WORKSPACE`; the smoke runner can only set `WORKSPACE` for a server it
starts itself.

## Provider Status

| Provider | Text | Local image | Stream | Cancel | Native session | Detection/auth notes |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | Yes | Yes | Yes | Abort signal | Yes | Requires the Codex SDK package plus a working `codex` CLI login. |
| Claude | Yes | No | Yes | SDK interrupt | Yes | Requires the Claude Agent SDK package plus a working `claude` CLI login. |
| Gemini | Yes | No | Yes | Abort signal | Yes | Uses `@google/gemini-cli-core`; auth defaults to Google login unless overridden by `AGENT_BRIDGE_GEMINI_AUTH_TYPE` or `options`. |
