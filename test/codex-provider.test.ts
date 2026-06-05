import { describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import {
  CodexProvider,
  codexClientOptions,
  resolveLocalCodexPathOverride,
  type CodexClientLike
} from "../src/providers/codex.provider.js";
import { ProcessRunnerService } from "../src/process/process-runner.service.js";
import type { ProviderRequest } from "../src/core/types.js";

function createProvider(codex: CodexClientLike): CodexProvider {
  return new CodexProvider(new ProcessRunnerService(), () => codex);
}

function createThread(threadId: string, events?: ThreadEvent[]) {
  const streamEvents: ThreadEvent[] = events ?? [
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
        for (const event of streamEvents) {
          yield event;
        }
      })()
    }))
  };
}

describe("CodexProvider session handling", () => {
  it("prefers the local Codex CLI path when constructing SDK options", () => {
    const localPath = resolveLocalCodexPathOverride();
    const options = codexClientOptions();

    expect(options.codexPathOverride).toBe(localPath);
  });

  it("lets explicit Codex SDK options override the local CLI path", () => {
    const options = codexClientOptions({ codexPathOverride: "C:\\custom\\codex.exe" });

    expect(options.codexPathOverride).toBe("C:\\custom\\codex.exe");
  });

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
      model: "gpt-test",
      approvalPolicy: "never",
      sandboxMode: "danger-full-access"
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
      model: undefined,
      approvalPolicy: "never",
      sandboxMode: "danger-full-access"
    });
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(response.session).toBe("thread_existing");
  });

  it("keeps going when Codex emits a recoverable native error event", async () => {
    const thread = createThread("thread_reconnect", [
      { type: "thread.started", thread_id: "thread_reconnect" },
      { type: "turn.started" },
      { type: "error", message: "Reconnecting... 2/5" },
      {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "agent_message",
          text: "pong"
        }
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0
        }
      }
    ]);
    const codex = {
      startThread: vi.fn(() => thread),
      resumeThread: vi.fn()
    };
    const provider = createProvider(codex);

    const response = await provider.invoke("inv_1", {
      provider: "codex",
      input: "ping",
      cwd: "C:\\repo"
    });

    expect(response.output).toBe("pong");
    expect(response.session).toBe("thread_reconnect");
  });

  it("lets request threadOptions override default Codex yolo settings", async () => {
    const thread = createThread("thread_safe");
    const codex = {
      startThread: vi.fn(() => thread),
      resumeThread: vi.fn()
    };
    const provider = createProvider(codex);

    await provider.invoke("inv_1", {
      provider: "codex",
      input: "ping",
      options: {
        threadOptions: {
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write"
        }
      }
    });

    expect(codex.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write"
      })
    );
  });

  it("does not let threadOptions override the bridge project directory", async () => {
    const thread = createThread("thread_project");
    const codex = {
      startThread: vi.fn(() => thread),
      resumeThread: vi.fn()
    };
    const provider = createProvider(codex);

    await provider.invoke("inv_1", {
      provider: "codex",
      input: "ping",
      cwd: "C:\\repo\\projects\\app",
      options: {
        threadOptions: {
          workingDirectory: "C:\\outside",
          additionalDirectories: ["C:\\outside"]
        }
      }
    });

    expect(codex.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "C:\\repo\\projects\\app"
      })
    );
    expect(codex.startThread).toHaveBeenCalledWith(
      expect.not.objectContaining({
        additionalDirectories: expect.anything()
      })
    );
  });
});
