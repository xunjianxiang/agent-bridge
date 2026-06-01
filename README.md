# AgentBridge

AgentBridge is a lightweight API gateway for local AI coding agents.

It adapts provider SDKs and CLIs behind one HTTP/SSE surface. It does not manage workflows or multi-agent orchestration.

## Development

```bash
npm install
npm run start:dev
```

Default server: `http://127.0.0.1:8787`

## API

- `GET /health`
- `GET /providers`
- `POST /invoke`
- `POST /cancel`
- `POST /stream` Server-Sent Events

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

## Provider Status

- Codex: implemented for invoke, stream, cancel, local image input, and native session resume.
- Gemini: implemented through the Gemini CLI for string input, stream, cancel, and native session resume.
- Claude: detection is present, but invocation is not implemented yet.
