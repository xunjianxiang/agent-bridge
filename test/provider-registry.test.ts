import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../src/providers/provider.registry.js";
import type {
  AgentProvider,
  ProviderCapabilities,
  ProviderId,
  ProviderInfo,
  ProviderRequest,
  ProviderResponse,
  StreamEvent
} from "../src/core/types.js";

class FakeProvider implements AgentProvider {
  readonly id: ProviderId;
  status: ProviderInfo["status"];
  readonly detect = vi.fn(async () => this.info());

  constructor(id: ProviderId, status: ProviderInfo["status"] = "available") {
    this.id = id;
    this.status = status;
  }

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      displayName: this.id,
      streaming: true,
      cancel: "abort-signal",
      nativeSession: false,
      tools: { builtin: false, mcp: false, hostProvided: false },
      input: { text: true, localImage: false, asyncMessages: false }
    };
  }

  async invoke(_rid: string, _request: ProviderRequest): Promise<ProviderResponse> {
    return { rid: "inv_1", provider: this.id };
  }

  async *stream(): AsyncIterable<StreamEvent> {
    return;
  }

  async cancel(): Promise<void> {
    return;
  }

  private info(): ProviderInfo {
    return {
      ...this.capabilities(),
      status: this.status,
      authStatus: "configured",
      diagnostics: [],
      lastCheckedAt: new Date().toISOString()
    };
  }
}

describe("ProviderRegistry detection cache", () => {
  const originalTtl = process.env.PROVIDER_DETECTION_TTL_MS;

  afterEach(() => {
    if (originalTtl === undefined) {
      delete process.env.PROVIDER_DETECTION_TTL_MS;
    } else {
      process.env.PROVIDER_DETECTION_TTL_MS = originalTtl;
    }
    vi.useRealTimers();
  });

  it("reuses fresh detection results without probing providers again", async () => {
    process.env.PROVIDER_DETECTION_TTL_MS = "1000";
    const codex = new FakeProvider("codex");
    const claude = new FakeProvider("claude");
    const gemini = new FakeProvider("gemini");
    const registry = new ProviderRegistry(codex as never, claude as never, gemini as never);

    await registry.detectAll();
    await registry.detectAll();

    expect(codex.detect).toHaveBeenCalledTimes(1);
    expect(claude.detect).toHaveBeenCalledTimes(1);
    expect(gemini.detect).toHaveBeenCalledTimes(1);
  });

  it("returns stale cached results immediately and refreshes them in the background", async () => {
    process.env.PROVIDER_DETECTION_TTL_MS = "1000";
    vi.useFakeTimers();
    const codex = new FakeProvider("codex", "available");
    const claude = new FakeProvider("claude", "missing");
    const gemini = new FakeProvider("gemini", "available");
    const registry = new ProviderRegistry(codex as never, claude as never, gemini as never);

    const first = await registry.detectAll();
    claude.status = "available";
    vi.advanceTimersByTime(1001);
    const stale = await registry.detectAll();
    await vi.runAllTimersAsync();
    await Promise.resolve();
    const updated = await registry.detectAll();

    expect(first.find((provider) => provider.id === "claude")?.status).toBe("missing");
    expect(stale.find((provider) => provider.id === "claude")?.status).toBe("missing");
    expect(updated.find((provider) => provider.id === "claude")?.status).toBe("available");
    expect(claude.detect).toHaveBeenCalledTimes(2);
  });

  it("coalesces passive refreshes while one refresh is already running", async () => {
    process.env.PROVIDER_DETECTION_TTL_MS = "1000";
    vi.useFakeTimers();
    const codex = new FakeProvider("codex");
    const claude = new FakeProvider("claude");
    const gemini = new FakeProvider("gemini");
    const registry = new ProviderRegistry(codex as never, claude as never, gemini as never);

    await registry.detectAll();
    vi.advanceTimersByTime(1001);
    await registry.detectAll();
    await registry.detectAll();

    expect(codex.detect).toHaveBeenCalledTimes(2);
    expect(claude.detect).toHaveBeenCalledTimes(2);
    expect(gemini.detect).toHaveBeenCalledTimes(2);
  });
});
