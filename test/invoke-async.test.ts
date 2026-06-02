import { describe, expect, it } from "vitest";
import { InvokeService } from "../src/invoke/invoke.service.js";
import { InvocationRegistryService } from "../src/invoke/invocation-registry.service.js";
import type {
  AgentProvider,
  ProviderCapabilities,
  ProviderInfo,
  ProviderRequest,
  ProviderResponse,
  StreamEvent
} from "../src/core/types.js";

class SlowProvider implements AgentProvider {
  readonly id = "codex" as const;
  cancelled = false;

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      displayName: "Slow",
      streaming: true,
      cancel: "abort-signal",
      nativeSession: false,
      tools: { builtin: false, mcp: false, hostProvided: false },
      input: { text: true, localImage: false, asyncMessages: false }
    };
  }

  async detect(): Promise<ProviderInfo> {
    return {
      ...this.capabilities(),
      status: "available",
      authStatus: "configured",
      diagnostics: [],
      lastCheckedAt: new Date().toISOString()
    };
  }

  async invoke(_requestId: string, request: ProviderRequest): Promise<ProviderResponse> {
    await new Promise<void>((resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true
      });
      setTimeout(resolve, 1000);
    });
    return { requestId: _requestId, provider: this.id, finalText: "done" };
  }

  async *stream(): AsyncIterable<StreamEvent> {
    return;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

describe("InvokeService async runs", () => {
  it("returns a request id immediately so callers can cancel the active run", async () => {
    const provider = new SlowProvider();
    const service = new InvokeService(
      { get: () => provider } as never,
      new InvocationRegistryService()
    );

    const run = service.start({
      provider: "codex",
      input: "keep running"
    });

    expect(run.status).toBe("running");
    await service.cancel(run.requestId);
    const status = await service.getRun(run.requestId);

    expect(provider.cancelled).toBe(true);
    expect(status.status).toBe("cancelled");
  });
});
