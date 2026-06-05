import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  BridgeError,
  ProviderId,
  ProviderRequest,
  ProviderResponse,
  StreamEvent
} from "../core/types.js";
import { providerRequestSchema } from "../core/request.schema.js";
import { createRid } from "../core/rid.js";
import { resolveProjectCwd } from "../core/workspace.js";
import { ProviderRegistry } from "../providers/provider.registry.js";

export type RunStatus =
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunEvent {
  id: number;
  event: "event" | "done" | "error";
  data: unknown;
  timestamp: string;
}

export interface RunSnapshot {
  id: string;
  provider: ProviderId;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  eventsUrl: string;
  session?: string;
  result?: unknown;
  error?: BridgeError;
}

interface RunRecord {
  id: string;
  provider: ProviderId;
  status: RunStatus;
  request: ProviderRequest;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  events: RunEvent[];
  nextEventId: number;
  session?: string;
  result?: unknown;
  error?: BridgeError;
  abortController: AbortController;
  cancel: () => Promise<void>;
  subscribers: Set<(event: RunEvent) => void>;
  cleanupTimer?: NodeJS.Timeout;
}

@Injectable()
export class RunsService {
  private readonly runs = new Map<string, RunRecord>();

  constructor(private readonly providers: ProviderRegistry) {}

  create(payload: unknown): RunSnapshot {
    const parsed = providerRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    const provider = this.providers.get(parsed.data.provider);
    const id = createRid();
    const abortController = new AbortController();
    const request = toProviderRequest(parsed.data, abortController.signal);
    const now = new Date().toISOString();
    const run: RunRecord = {
      id,
      provider: provider.id,
      status: "running",
      request,
      createdAt: now,
      updatedAt: now,
      events: [],
      nextEventId: 1,
      abortController,
      cancel: () => provider.cancel(id),
      subscribers: new Set()
    };

    this.runs.set(id, run);
    void this.execute(run, provider);

    return snapshot(run);
  }

  get(id: string): RunSnapshot {
    return snapshot(this.getRecord(id));
  }

  eventsSince(id: string, lastEventId = 0): RunEvent[] {
    const run = this.getRecord(id);
    return run.events.filter((event) => event.id > lastEventId);
  }

  subscribe(id: string, subscriber: (event: RunEvent) => void): () => void {
    const run = this.getRecord(id);
    run.subscribers.add(subscriber);
    return () => {
      run.subscribers.delete(subscriber);
    };
  }

  async cancel(id: string): Promise<RunSnapshot> {
    const run = this.getRecord(id);
    if (isTerminal(run.status)) {
      return snapshot(run);
    }

    run.status = "cancelling";
    run.updatedAt = new Date().toISOString();
    run.abortController.abort();
    await run.cancel();
    return snapshot(run);
  }

  private async execute(
    run: RunRecord,
    provider: ReturnType<ProviderRegistry["get"]>
  ): Promise<void> {
    try {
      for await (const event of provider.stream(run.id, run.request)) {
        this.recordProviderEvent(run, event);
        if (event.type === "done") {
          this.complete(run, event.response);
          return;
        }
        if (event.type === "error") {
          this.fail(run, event.error);
          return;
        }
      }

      if (!isTerminal(run.status)) {
        this.complete(run);
      }
    } catch (error) {
      this.fail(run, {
        code: "RUN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        provider: run.provider
      });
    }
  }

  private recordProviderEvent(run: RunRecord, event: StreamEvent): void {
    if (event.type === "done" || event.type === "error") {
      return;
    }

    this.append(run, "event", event.event, event.timestamp);
  }

  private complete(run: RunRecord, response?: ProviderResponse): void {
    if (run.status === "cancelling") {
      run.status = "cancelled";
    } else {
      run.status = "completed";
    }
    run.session = response?.session ?? run.request.session;
    run.result = response?.raw ?? response;
    this.finish(run);
    this.append(run, "done", {
      status: run.status,
      session: run.session,
      result: run.result
    });
  }

  private fail(run: RunRecord, error: BridgeError): void {
    if (run.status === "cancelling" || run.abortController.signal.aborted) {
      run.status = "cancelled";
    } else {
      run.status = "failed";
      run.error = error;
    }
    this.finish(run);
    this.append(run, run.status === "failed" ? "error" : "done", {
      status: run.status,
      error: run.error
    });
  }

  private finish(run: RunRecord): void {
    const now = new Date().toISOString();
    run.updatedAt = now;
    run.completedAt = now;
    this.scheduleCleanup(run);
  }

  private append(
    run: RunRecord,
    event: RunEvent["event"],
    data: unknown,
    timestamp = new Date().toISOString()
  ): void {
    const runEvent: RunEvent = {
      id: run.nextEventId,
      event,
      data,
      timestamp
    };
    run.nextEventId += 1;
    run.events.push(runEvent);
    run.updatedAt = timestamp;
    for (const subscriber of run.subscribers) {
      subscriber(runEvent);
    }
  }

  private getRecord(id: string): RunRecord {
    const run = this.runs.get(id);
    if (!run) {
      throw new NotFoundException(`Run not found: ${id}`);
    }
    return run;
  }

  private scheduleCleanup(run: RunRecord): void {
    if (run.cleanupTimer) {
      clearTimeout(run.cleanupTimer);
    }

    run.cleanupTimer = setTimeout(() => {
      this.runs.delete(run.id);
    }, runRetentionTtlMs());
    run.cleanupTimer.unref?.();
  }
}

function snapshot(run: RunRecord): RunSnapshot {
  return {
    id: run.id,
    provider: run.provider,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    eventsUrl: `/runs/${run.id}/events`,
    session: run.session,
    result: run.result,
    error: run.error
  };
}

function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function runRetentionTtlMs(): number {
  const raw = Number(process.env.RUN_RETENTION_TTL_MS ?? "600000");
  return Number.isFinite(raw) && raw >= 0 ? raw : 600000;
}

function toProviderRequest(
  parsed: ReturnType<typeof providerRequestSchema.parse>,
  signal: AbortSignal
): ProviderRequest {
  const { project, ...request } = parsed;
  try {
    return {
      ...request,
      cwd: resolveProjectCwd(project),
      signal
    };
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : String(error));
  }
}
