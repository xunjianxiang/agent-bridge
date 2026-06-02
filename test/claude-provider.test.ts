import { describe, expect, it, vi } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeProvider, type ClaudeQuery } from "../src/providers/claude.provider.js";
import type { ProcessRunnerService } from "../src/process/process-runner.service.js";

function createProvider(query: ClaudeQuery): ClaudeProvider {
  return new ClaudeProvider({} as ProcessRunnerService, query);
}

function asQuery(value: Pick<Query, typeof Symbol.asyncIterator | "close">): Query {
  return value as Query;
}

function claudeMessage(content: string, sessionId = "session_new"): SDKMessage {
  return {
    type: "assistant",
    session_id: sessionId,
    uuid: "00000000-0000-4000-8000-000000000001",
    parent_tool_use_id: null,
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }
    }
  } as unknown as SDKMessage;
}

function claudeResult(result: string, sessionId = "session_new"): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    uuid: "00000000-0000-4000-8000-000000000002",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: []
  } as unknown as SDKMessage;
}

describe("ClaudeProvider", () => {
  it("invokes Claude Agent SDK and returns final text with session id", async () => {
    const query = vi.fn(() =>
      asQuery({
      [Symbol.asyncIterator]: async function* () {
        yield claudeMessage("pong");
        yield claudeResult("pong");
      },
      close: vi.fn()
      })
    );
    const provider = createProvider(query);

    const response = await provider.invoke("inv_1", {
      provider: "claude",
      input: "Reply with exactly: pong",
      cwd: "C:\\repo",
      model: "claude-test"
    });

    expect(query).toHaveBeenCalledWith({
      prompt: "Reply with exactly: pong",
      options: expect.objectContaining({
        cwd: "C:\\repo",
        model: "claude-test"
      })
    });
    expect(response).toMatchObject({
      rid: "inv_1",
      provider: "claude",
      session: "session_new",
      output: "pong"
    });
  });

  it("resumes an existing Claude session when session id is provided", async () => {
    const query = vi.fn(() =>
      asQuery({
      [Symbol.asyncIterator]: async function* () {
        yield claudeResult("resumed", "session_existing");
      },
      close: vi.fn()
      })
    );
    const provider = createProvider(query);

    await provider.invoke("inv_1", {
      provider: "claude",
      input: "Continue",
      session: "session_existing"
    });

    expect(query).toHaveBeenCalledWith({
      prompt: "Continue",
      options: expect.objectContaining({
        resume: "session_existing"
      })
    });
  });

  it("closes the active Claude query when cancelled", async () => {
    let resolveStarted!: () => void;
    let resolveClosed!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const close = vi.fn(() => resolveClosed());
    const query = vi.fn(() =>
      asQuery({
      [Symbol.asyncIterator]: async function* () {
        resolveStarted();
        await closed;
      },
      close
      })
    );
    const provider = createProvider(query);

    const stream = provider.stream("inv_1", {
      provider: "claude",
      input: "keep running"
    });
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    await started;

    await provider.cancel("inv_1");
    await pending;

    expect(close).toHaveBeenCalledOnce();
  });
});
