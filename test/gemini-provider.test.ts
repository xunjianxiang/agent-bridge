import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GEMINI_CORE_CONFIG_FACTORY,
  GEMINI_CORE_SESSION_FACTORY,
  GeminiProvider,
  createGeminiConfigParameters,
  type GeminiCoreConfigLike,
  type GeminiCoreSessionLike
} from "../src/providers/gemini.provider.js";
import type { AgentEvent } from "@google/gemini-cli-core";
import type { ConversationRecord } from "@google/gemini-cli-core";
import type { ProcessRunnerService } from "../src/process/process-runner.service.js";

function event(type: string, data: Record<string, unknown>): AgentEvent {
  return {
    id: `evt_${type}`,
    streamId: "stream_1",
    timestamp: "2026-06-02T00:00:00.000Z",
    type,
    ...data
  } as AgentEvent;
}

function createConfig(overrides: Partial<GeminiCoreConfigLike> = {}): GeminiCoreConfigLike {
  return {
    initialize: vi.fn(),
    getSessionId: vi.fn(() => "session_new"),
    getModel: vi.fn(() => "gemini-test"),
    loadSession: vi.fn(async () => null),
    getGeminiClient: vi.fn(() => ({})),
    ...overrides
  };
}

function createSession(events: AgentEvent[]): GeminiCoreSessionLike {
  return {
    async *sendStream() {
      for (const item of events) {
        yield item;
      }
    },
    abort: vi.fn()
  };
}

describe("GeminiProvider core adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses Gemini yolo approval mode by default", () => {
    const params = createGeminiConfigParameters(
      {
        provider: "gemini",
        input: "Run without prompts",
        cwd: "C:/repo"
      },
      "inv_1"
    );

    expect(params.approvalMode).toBe("yolo");
    expect(params.disableYoloMode).toBe(false);
    expect(params.trustedFolder).toBe(true);
    expect(params.interactive).toBe(false);
  });

  it("allows Gemini config overrides to replace the default yolo mode", () => {
    const params = createGeminiConfigParameters(
      {
        provider: "gemini",
        input: "Run with custom config",
        options: {
          geminiConfig: {
            approvalMode: "default",
            disableYoloMode: true
          }
        }
      },
      "inv_1"
    );

    expect(params.approvalMode).toBe("default");
    expect(params.disableYoloMode).toBe(true);
  });

  it("does not let Gemini config override the bridge project directory", () => {
    const params = createGeminiConfigParameters(
      {
        provider: "gemini",
        input: "Run in project",
        cwd: "C:/repo/projects/app",
        session: "session_bridge",
        options: {
          geminiConfig: {
            cwd: "C:/outside",
            targetDir: "C:/outside",
            sessionId: "session_outside",
            includeDirectories: ["C:/outside"]
          }
        }
      },
      "inv_1"
    );

    expect(params.cwd).toBe("C:/repo/projects/app");
    expect(params.targetDir).toBe("C:/repo/projects/app");
    expect(params.sessionId).toBe("session_bridge");
    expect(params.includeDirectories).toBeUndefined();
  });

  it("returns the Gemini core session id from the initialize event", async () => {
    const config = createConfig();
    const session = createSession([
      event("initialize", {
        sessionId: "session_new",
        workspace: "C:/repo",
        agentId: "gemini"
      }),
      event("message", {
        role: "agent",
        content: [{ type: "text", text: "pong" }]
      }),
      event("agent_end", {
        reason: "completed",
        data: { outputTokens: 1 }
      })
    ]);
    const provider = new GeminiProvider({} as ProcessRunnerService, {
      [GEMINI_CORE_CONFIG_FACTORY]: () => config,
      [GEMINI_CORE_SESSION_FACTORY]: () => session
    });

    const response = await provider.invoke("inv_1", {
      provider: "gemini",
      input: "Reply with exactly: pong",
      cwd: "C:/repo"
    });

    expect(response.session).toBe("session_new");
    expect(response.output).toBe("pong");
  });

  it("loads native session history before creating a resumed Gemini core session", async () => {
    const resumedSession: ConversationRecord = {
      sessionId: "session_existing",
      projectHash: "project_hash",
      startTime: "2026-06-02T00:00:00.000Z",
      lastUpdated: "2026-06-02T00:00:00.000Z",
      messages: [
        {
          id: "msg_1",
          timestamp: "2026-06-02T00:00:00.000Z",
          type: "user",
          content: [{ text: "Earlier turn" }]
        }
      ]
    };
    const loadSession = vi.fn(async () => resumedSession);
    const storageInitialize = vi.fn();
    const config = createConfig({ loadSession, storage: { initialize: storageInitialize } });
    const sessionFactory = vi.fn(() =>
      createSession([
        event("initialize", {
          sessionId: "session_existing",
          workspace: "C:/repo",
          agentId: "gemini"
        }),
        event("message", {
          role: "agent",
          content: [{ type: "text", text: "resumed" }]
        }),
        event("agent_end", { reason: "completed" })
      ])
    );
    const provider = new GeminiProvider({} as ProcessRunnerService, {
      [GEMINI_CORE_CONFIG_FACTORY]: () => config,
      [GEMINI_CORE_SESSION_FACTORY]: sessionFactory
    });

    await provider.invoke("inv_1", {
      provider: "gemini",
      input: "Continue",
      cwd: "C:/repo",
      session: "session_existing"
    });

    expect(loadSession).toHaveBeenCalledWith("session_existing");
    expect(storageInitialize.mock.invocationCallOrder[0]).toBeLessThan(
      loadSession.mock.invocationCallOrder[0]
    );
    expect(loadSession.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(config.initialize).mock.invocationCallOrder[0]
    );
    expect(sessionFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        client: config.getGeminiClient(),
        streamId: "session_existing"
      })
    );
  });

  it("aborts the active Gemini core session when cancelled", async () => {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const session = {
      async *sendStream() {
        yield event("initialize", {
          sessionId: "session_new",
          workspace: "C:/repo",
          agentId: "gemini"
        });
        await new Promise<void>((resolve) => {
          release = resolve;
          started();
        });
        yield event("agent_end", { reason: "completed" });
      },
      abort: vi.fn(async () => {
        release();
      })
    };
    const provider = new GeminiProvider({} as ProcessRunnerService, {
      [GEMINI_CORE_CONFIG_FACTORY]: () => createConfig(),
      [GEMINI_CORE_SESSION_FACTORY]: () => session
    });

    const run = provider.invoke("inv_1", {
      provider: "gemini",
      input: "Wait",
      cwd: "C:/repo"
    });
    await startedPromise;

    await provider.cancel("inv_1");
    await run;

    expect(session.abort).toHaveBeenCalled();
  });

  it("detects Gemini core availability without invoking the Gemini CLI", async () => {
    const processRunner = {
      run: vi.fn(),
      spawn: vi.fn()
    } as unknown as ProcessRunnerService;
    const provider = new GeminiProvider(processRunner, {
      [GEMINI_CORE_CONFIG_FACTORY]: () => createConfig()
    });

    const info = await provider.detect();

    expect(info.status).toBe("available");
    expect(info.executable).toBeUndefined();
    expect(processRunner.run).not.toHaveBeenCalled();
    expect(processRunner.spawn).not.toHaveBeenCalled();
  });

  it("returns misconfigured when Gemini core detection does not finish before its deadline", async () => {
    vi.useFakeTimers();
    const provider = new GeminiProvider({} as ProcessRunnerService, {
      [GEMINI_CORE_CONFIG_FACTORY]: () =>
        createConfig({
          initialize: () => new Promise(() => undefined)
        })
    });

    const detection = provider.detect();
    await vi.advanceTimersByTimeAsync(3001);

    await expect(detection).resolves.toMatchObject({
      status: "misconfigured",
      authStatus: "missing",
      diagnostics: [
        "Gemini core initialization failed: Gemini core initialization timed out after 3000ms"
      ]
    });
  });

  it("uses local OAuth auth by default even when API key environment variables exist", async () => {
    const previousApiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "invalid-test-key";
    const refreshAuth = vi.fn();
    const provider = new GeminiProvider({} as ProcessRunnerService, {
      [GEMINI_CORE_CONFIG_FACTORY]: () => createConfig({ refreshAuth })
    });

    try {
      await provider.detect();
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.GEMINI_API_KEY;
      } else {
        process.env.GEMINI_API_KEY = previousApiKey;
      }
    }

    expect(refreshAuth).toHaveBeenCalledWith(
      "oauth-personal",
      undefined,
      undefined,
      undefined
    );
  });

  it("loads native sessions from Gemini storage-relative chat file paths", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-bridge-gemini-"));
    const chatsDir = join(tempDir, "chats");
    const sessionFile = join(chatsDir, "session-2026-06-02T00-00-session_.jsonl");
    await mkdir(chatsDir, { recursive: true });
    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          sessionId: "session_existing",
          projectHash: "project_hash",
          startTime: "2026-06-02T00:00:00.000Z",
          lastUpdated: "2026-06-02T00:00:00.000Z",
          kind: "main"
        }),
        JSON.stringify({
          id: "msg_1",
          timestamp: "2026-06-02T00:00:00.000Z",
          type: "user",
          content: [{ text: "Remember token_alpha" }]
        })
      ].join("\n"),
      "utf8"
    );
    const config = createConfig({
      storage: {
        getProjectTempDir: () => tempDir,
        listProjectChatFiles: async () => [
          {
            filePath: join("chats", "session-2026-06-02T00-00-session_.jsonl"),
            lastUpdated: "2026-06-02T00:00:00.000Z"
          }
        ]
      }
    });
    const provider = new GeminiProvider({} as ProcessRunnerService);

    try {
      const loaded = await (
        provider as unknown as {
          loadSession(
            config: GeminiCoreConfigLike,
            sessionId: string
          ): Promise<{ conversation: ConversationRecord } | null>;
        }
      ).loadSession(config, "session_existing");

      expect(loaded?.conversation.sessionId).toBe("session_existing");
      expect(loaded?.conversation.messages[0]?.content).toEqual([
        { text: "Remember token_alpha" }
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips empty same-session Gemini chat files when resuming", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-bridge-gemini-"));
    const chatsDir = join(tempDir, "chats");
    await mkdir(chatsDir, { recursive: true });
    const emptyFileName = "session-2026-06-02T00-01-session_.jsonl";
    const historyFileName = "session-2026-06-02T00-00-session_.jsonl";
    await writeFile(
      join(chatsDir, emptyFileName),
      `${JSON.stringify({
        sessionId: "session_existing",
        projectHash: "project_hash",
        startTime: "2026-06-02T00:01:00.000Z",
        lastUpdated: "2026-06-02T00:01:00.000Z",
        kind: "main"
      })}\n`,
      "utf8"
    );
    await writeFile(
      join(chatsDir, historyFileName),
      [
        JSON.stringify({
          sessionId: "session_existing",
          projectHash: "project_hash",
          startTime: "2026-06-02T00:00:00.000Z",
          lastUpdated: "2026-06-02T00:00:00.000Z",
          kind: "main"
        }),
        JSON.stringify({
          id: "msg_1",
          timestamp: "2026-06-02T00:00:00.000Z",
          type: "user",
          content: [{ text: "Remember token_alpha" }]
        })
      ].join("\n"),
      "utf8"
    );
    const config = createConfig({
      storage: {
        getProjectTempDir: () => tempDir,
        listProjectChatFiles: async () => [
          { filePath: join("chats", emptyFileName), lastUpdated: "2026-06-02T00:01:00.000Z" },
          { filePath: join("chats", historyFileName), lastUpdated: "2026-06-02T00:00:00.000Z" }
        ]
      }
    });
    const provider = new GeminiProvider({} as ProcessRunnerService);

    try {
      const loaded = await (
        provider as unknown as {
          loadSession(
            config: GeminiCoreConfigLike,
            sessionId: string
          ): Promise<{ conversation: ConversationRecord } | null>;
        }
      ).loadSession(config, "session_existing");

      expect(loaded?.conversation.messages).toHaveLength(1);
      expect(loaded?.conversation.messages[0]?.content).toEqual([
        { text: "Remember token_alpha" }
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to Gemini storage when core loadSession returns an empty conversation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-bridge-gemini-"));
    const chatsDir = join(tempDir, "chats");
    const historyFileName = "session-2026-06-02T00-00-session_.jsonl";
    await mkdir(chatsDir, { recursive: true });
    await writeFile(
      join(chatsDir, historyFileName),
      [
        JSON.stringify({
          sessionId: "session_existing",
          projectHash: "project_hash",
          startTime: "2026-06-02T00:00:00.000Z",
          lastUpdated: "2026-06-02T00:00:00.000Z",
          kind: "main"
        }),
        JSON.stringify({
          id: "msg_1",
          timestamp: "2026-06-02T00:00:00.000Z",
          type: "user",
          content: [{ text: "Remember token_alpha" }]
        })
      ].join("\n"),
      "utf8"
    );
    const config = createConfig({
      loadSession: vi.fn(async () => ({
        sessionId: "session_existing",
        projectHash: "project_hash",
        startTime: "2026-06-02T00:01:00.000Z",
        lastUpdated: "2026-06-02T00:01:00.000Z",
        messages: []
      })),
      storage: {
        getProjectTempDir: () => tempDir,
        listProjectChatFiles: async () => [
          { filePath: join("chats", historyFileName), lastUpdated: "2026-06-02T00:00:00.000Z" }
        ]
      }
    });
    const provider = new GeminiProvider({} as ProcessRunnerService);

    try {
      const loaded = await (
        provider as unknown as {
          loadSession(
            config: GeminiCoreConfigLike,
            sessionId: string
          ): Promise<{ conversation: ConversationRecord } | null>;
        }
      ).loadSession(config, "session_existing");

      expect(loaded?.conversation.messages).toHaveLength(1);
      expect(loaded?.conversation.messages[0]?.content).toEqual([
        { text: "Remember token_alpha" }
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
