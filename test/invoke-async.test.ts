import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
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
  lastRequest?: ProviderRequest;

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

  async invoke(_rid: string, request: ProviderRequest): Promise<ProviderResponse> {
    this.lastRequest = request;
    await new Promise<void>((resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true
      });
      setTimeout(resolve, 1000);
    });
    return { rid: _rid, provider: this.id, output: "done" };
  }

  async *stream(): AsyncIterable<StreamEvent> {
    return;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

describe("InvokeService async runs", () => {
  const originalWorkspace = process.env.WORKSPACE;

  afterEach(() => {
    if (originalWorkspace === undefined) {
      delete process.env.WORKSPACE;
    } else {
      process.env.WORKSPACE = originalWorkspace;
    }
  });

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
    await service.cancel(run.rid);
    const status = await service.getRun(run.rid);

    expect(provider.cancelled).toBe(true);
    expect(status.status).toBe("cancelled");
  });

  it("resolves the public project field into an internal provider cwd", async () => {
    process.env.WORKSPACE = resolve("C:\\repo");
    const provider = new SlowProvider();
    const service = new InvokeService(
      { get: () => provider } as never,
      new InvocationRegistryService()
    );

    const run = service.start({
      provider: "codex",
      project: "packages/api",
      input: "keep running"
    });

    expect(provider.lastRequest?.cwd).toBe(resolve("C:\\repo", "projects", "packages/api"));
    await service.cancel(run.rid);
  });
});
