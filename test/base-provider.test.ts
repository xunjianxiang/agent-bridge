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
      type: "event",
      rid: "inv_1",
      provider: this.id,
      event: { type: "system", content: "initialized" },
      timestamp: new Date().toISOString()
    };
    yield {
      type: "event",
      rid: "inv_1",
      provider: this.id,
      event: { type: "assistant", delta: "pong" },
      timestamp: new Date().toISOString()
    };
    yield {
      type: "done",
      rid: "inv_1",
      provider: this.id,
      timestamp: new Date().toISOString(),
      response: {
        rid: "inv_1",
        provider: "gemini",
        output: "pong"
      }
    };
  }
}

class RecoveringProvider extends FakeProvider {
  override async *stream(): AsyncIterable<StreamEvent> {
    yield {
      type: "error",
      rid: "inv_1",
      provider: this.id,
      timestamp: new Date().toISOString(),
      error: {
        code: "TRANSIENT",
        message: "reconnecting",
        provider: "gemini"
      }
    };
    yield {
      type: "event",
      rid: "inv_1",
      provider: this.id,
      event: { type: "assistant", delta: "pong" },
      timestamp: new Date().toISOString()
    };
    yield {
      type: "done",
      rid: "inv_1",
      provider: this.id,
      timestamp: new Date().toISOString(),
      response: {
        rid: "inv_1",
        provider: "gemini",
        output: "pong"
      }
    };
  }
}

class HangingAfterDoneProvider extends FakeProvider {
  override async *stream(): AsyncIterable<StreamEvent> {
    yield {
      type: "event",
      rid: "inv_1",
      provider: this.id,
      event: { type: "assistant", delta: "pong" },
      timestamp: new Date().toISOString()
    };
    yield {
      type: "done",
      rid: "inv_1",
      provider: this.id,
      timestamp: new Date().toISOString(),
      response: {
        rid: "inv_1",
        provider: "gemini",
        output: "pong"
      }
    };
    await new Promise(() => undefined);
  }
}

describe("BaseProvider", () => {
  it("returns provider output from the done response", async () => {
    const provider = new FakeProvider();
    const request: ProviderRequest = {
      provider: "gemini",
      input: "ping"
    };

    const response = await provider.invoke("inv_1", request);

    expect(response.output).toBe("pong");
  });

  it("does not fail invoke when an error event is followed by done", async () => {
    const provider = new RecoveringProvider();
    const request: ProviderRequest = {
      provider: "gemini",
      input: "ping"
    };

    const response = await provider.invoke("inv_1", request);

    expect(response.output).toBe("pong");
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
    expect(response).toMatchObject({ output: "pong" });
  });
});
