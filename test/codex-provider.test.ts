import { describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexProvider, type CodexClientLike } from "../src/providers/codex.provider.js";
import { ProcessRunnerService } from "../src/process/process-runner.service.js";
import type { ProviderRequest } from "../src/core/types.js";

function createProvider(codex: CodexClientLike): CodexProvider {
  return new CodexProvider(new ProcessRunnerService(), () => codex);
}

function createThread(threadId: string) {
  const events: ThreadEvent[] = [
    { type: "thread.started", thread_id: threadId },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0
      }
    }
  ];

  return {
    runStreamed: vi.fn(async () => ({
      events: (async function* () {
        for (const event of events) {
          yield event;
        }
      })()
    }))
  };
}

describe("CodexProvider session handling", () => {
  it("starts a new thread when no native session id is provided", async () => {
    const thread = createThread("thread_new");
    const codex = {
      startThread: vi.fn(() => thread),
      resumeThread: vi.fn()
    };
    const provider = createProvider(codex);

    const response = await provider.invoke("inv_1", {
      provider: "codex",
      input: "ping",
      cwd: "C:\\repo",
      model: "gpt-test"
    });

    expect(codex.startThread).toHaveBeenCalledWith({
      workingDirectory: "C:\\repo",
      model: "gpt-test"
    });
    expect(codex.resumeThread).not.toHaveBeenCalled();
    expect(response.session).toBe("thread_new");
  });

  it("resumes an existing thread when native session id is provided", async () => {
    const thread = createThread("thread_existing");
    const codex = {
      startThread: vi.fn(),
      resumeThread: vi.fn(() => thread)
    };
    const provider = createProvider(codex);
    const request: ProviderRequest = {
      provider: "codex",
      input: "continue",
      session: "thread_existing",
      cwd: "C:\\repo"
    };

    const response = await provider.invoke("inv_1", request);

    expect(codex.resumeThread).toHaveBeenCalledWith("thread_existing", {
      workingDirectory: "C:\\repo",
      model: undefined
    });
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(response.session).toBe("thread_existing");
  });
});
