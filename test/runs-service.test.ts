import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentProvider,
  ProviderCapabilities,
  ProviderInfo,
  ProviderRequest,
  ProviderResponse,
  StreamEvent
} from "../src/core/types.js";
import { RunsService } from "../src/runs/runs.service.js";

class FakeProvider implements AgentProvider {
  readonly id = "codex" as const;
  started = 0;
  cancelled = false;
  release?: () => void;

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      displayName: "Fake",
      streaming: true,
      cancel: "abort-signal",
      nativeSession: true,
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

  async invoke(rid: string): Promise<ProviderResponse> {
    return { rid, provider: this.id, output: "done" };
  }

  async *stream(rid: string, request: ProviderRequest): AsyncIterable<StreamEvent> {
    this.started += 1;
    yield {
      type: "event",
      rid,
      provider: this.id,
      event: { type: "assistant", content: `input:${request.input}` },
      timestamp: "2026-06-03T00:00:00.000Z"
    };
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    yield {
      type: "done",
      rid,
      provider: this.id,
      response: {
        rid,
        provider: this.id,
        session: "session_1",
        output: "done"
      },
      timestamp: "2026-06-03T00:00:01.000Z"
    };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.release?.();
  }
}

describe("RunsService", () => {
  const originalWorkspace = process.env.WORKSPACE;

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.RUN_RETENTION_TTL_MS;
    if (originalWorkspace === undefined) {
      delete process.env.WORKSPACE;
    } else {
      process.env.WORKSPACE = originalWorkspace;
    }
  });

  it("creates a background run and replays buffered events without starting the provider twice", async () => {
    const provider = new FakeProvider();
    const service = new RunsService({ get: () => provider } as never);

    const run = service.create({
      provider: "codex",
      input: "ping"
    });
    await vi.waitFor(() => expect(service.eventsSince(run.id)).toHaveLength(1));

    const firstReplay = service.eventsSince(run.id);
    const secondReplay = service.eventsSince(run.id);

    expect(firstReplay).toHaveLength(1);
    expect(secondReplay).toHaveLength(1);
    expect(firstReplay[0]?.data).toEqual({
      type: "assistant",
      content: "input:ping"
    });
    expect(provider.started).toBe(1);

    provider.release?.();
    await vi.waitFor(() =>
      expect(service.get(run.id).status).toBe("completed")
    );
  });

  it("supports Last-Event-ID style replay from the next event", async () => {
    const provider = new FakeProvider();
    const service = new RunsService({ get: () => provider } as never);

    const run = service.create({
      provider: "codex",
      input: "ping"
    });
    await vi.waitFor(() => expect(service.eventsSince(run.id)).toHaveLength(1));

    provider.release?.();
    await vi.waitFor(() =>
      expect(service.get(run.id).status).toBe("completed")
    );

    const replay = service.eventsSince(run.id, 1);

    expect(replay).toHaveLength(1);
    expect(replay[0]?.event).toBe("done");
  });

  it("cancels an active run explicitly", async () => {
    const provider = new FakeProvider();
    const service = new RunsService({ get: () => provider } as never);

    const run = service.create({
      provider: "codex",
      input: "ping"
    });
    await vi.waitFor(() => expect(provider.started).toBe(1));

    const cancelled = await service.cancel(run.id);

    expect(provider.cancelled).toBe(true);
    expect(cancelled.status).toBe("cancelling");
  });

  it("expires completed runs after the retention ttl", async () => {
    process.env.RUN_RETENTION_TTL_MS = "100";
    const provider = new FakeProvider();
    const service = new RunsService({ get: () => provider } as never);

    const run = service.create({
      provider: "codex",
      input: "ping"
    });
    await vi.waitFor(() => expect(service.eventsSince(run.id)).toHaveLength(1));
    provider.release?.();
    await vi.waitFor(() =>
      expect(service.get(run.id).status).toBe("completed")
    );

    await vi.waitFor(() =>
      expect(() => service.get(run.id)).toThrow("Run not found")
    );
  });
});
