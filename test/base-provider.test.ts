import { describe, expect, it } from "vitest";
import { BaseProvider } from "../src/providers/base-provider.js";
import type {
  ProviderCapabilities,
  ProviderInfo,
  ProviderRequest,
  StreamEvent
} from "../src/core/types.js";

class FakeProvider extends BaseProvider {
  readonly id = "gemini" as const;

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      displayName: "Fake",
      streaming: true,
      cancel: "process-kill",
      nativeSession: false,
      tools: { builtin: false, mcp: false, hostProvided: false },
      input: { text: true, localImage: false, asyncMessages: false }
    };
  }

  async detect(): Promise<ProviderInfo> {
    return this.info("available");
  }

  async *stream(): AsyncIterable<StreamEvent> {
    yield {
      type: "message",
      requestId: "inv_1",
      role: "system",
      content: "initialized",
      timestamp: new Date().toISOString()
    };
    yield {
      type: "message",
      requestId: "inv_1",
      role: "assistant",
      delta: "pong",
      timestamp: new Date().toISOString()
    };
    yield {
      type: "done",
      requestId: "inv_1",
      timestamp: new Date().toISOString(),
      response: {
        requestId: "inv_1",
        provider: "gemini"
      }
    };
  }
}

class RecoveringProvider extends FakeProvider {
  override async *stream(): AsyncIterable<StreamEvent> {
    yield {
      type: "error",
      requestId: "inv_1",
      timestamp: new Date().toISOString(),
      error: {
        code: "TRANSIENT",
        message: "reconnecting",
        provider: "gemini"
      }
    };
    yield {
      type: "message",
      requestId: "inv_1",
      role: "assistant",
      delta: "pong",
      timestamp: new Date().toISOString()
    };
    yield {
      type: "done",
      requestId: "inv_1",
      timestamp: new Date().toISOString(),
      response: {
        requestId: "inv_1",
        provider: "gemini"
      }
    };
  }
}

class HangingAfterDoneProvider extends FakeProvider {
  override async *stream(): AsyncIterable<StreamEvent> {
    yield {
      type: "message",
      requestId: "inv_1",
      role: "assistant",
      delta: "pong",
      timestamp: new Date().toISOString()
    };
    yield {
      type: "done",
      requestId: "inv_1",
      timestamp: new Date().toISOString(),
      response: {
        requestId: "inv_1",
        provider: "gemini"
      }
    };
    await new Promise(() => undefined);
  }
}

describe("BaseProvider", () => {
  it("returns assistant text as finalText when done response does not include it", async () => {
    const provider = new FakeProvider();
    const request: ProviderRequest = {
      provider: "gemini",
      input: "ping"
    };

    const response = await provider.invoke("inv_1", request);

    expect(response.finalText).toBe("pong");
  });

  it("does not fail invoke when an error event is followed by done", async () => {
    const provider = new RecoveringProvider();
    const request: ProviderRequest = {
      provider: "gemini",
      input: "ping"
    };

    const response = await provider.invoke("inv_1", request);

    expect(response.finalText).toBe("pong");
  });

  it("echoes the requested session when the provider response omits it", async () => {
    const provider = new FakeProvider();
    const request: ProviderRequest = {
      provider: "gemini",
      input: "ping",
      session: "session_123"
    };

    const response = await provider.invoke("inv_1", request);

    expect(response.session).toBe("session_123");
  });

  it("returns as soon as a done event is received", async () => {
    const provider = new HangingAfterDoneProvider();
    const request: ProviderRequest = {
      provider: "gemini",
      input: "ping"
    };

    const response = await Promise.race([
      provider.invoke("inv_1", request),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 50))
    ]);

    expect(response).not.toBe("timed-out");
    expect(response).toMatchObject({ finalText: "pong" });
  });
});
