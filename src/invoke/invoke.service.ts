import { BadRequestException, Injectable } from "@nestjs/common";
import type { BridgeError, ProviderId, ProviderRequest, ProviderResponse } from "../core/types.js";
import { providerRequestSchema } from "../core/request.schema.js";
import { createRid } from "../core/rid.js";
import { resolveProjectCwd } from "../core/workspace.js";
import { ProviderRegistry } from "../providers/provider.registry.js";
import { InvocationRegistryService } from "./invocation-registry.service.js";

@Injectable()
export class InvokeService {
  private readonly runs = new Map<string, InvokeRun>();

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly invocations: InvocationRegistryService
  ) {}

  async invoke(payload: unknown): Promise<ProviderResponse> {
    const parsed = providerRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    const rid = createRid();
    const provider = this.providers.get(parsed.data.provider);
    const handle = this.invocations.create(rid, provider.id, () =>
      provider.cancel(rid)
    );

    const request = toProviderRequest(parsed.data, handle.abortController.signal);

    try {
      return await provider.invoke(rid, request);
    } finally {
      this.invocations.delete(rid);
    }
  }

  start(payload: unknown): InvokeRunSnapshot {
    const parsed = providerRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    const rid = createRid();
    const provider = this.providers.get(parsed.data.provider);
    const handle = this.invocations.create(rid, provider.id, () =>
      provider.cancel(rid)
    );
    const request = toProviderRequest(parsed.data, handle.abortController.signal);
    const run: InvokeRun = {
      rid,
      provider: provider.id,
      status: "running"
    };
    this.runs.set(rid, run);

    void provider
      .invoke(rid, request)
      .then((response) => {
        const current = this.runs.get(rid);
        if (!current || current.status === "cancelled") {
          return;
        }
        current.status = "completed";
        current.response = response;
      })
      .catch((error) => {
        const current = this.runs.get(rid);
        if (!current || current.status === "cancelled") {
          return;
        }
        current.status = handle.abortController.signal.aborted ? "cancelled" : "failed";
        current.error = toBridgeError(error, provider.id);
      })
      .finally(() => {
        this.invocations.delete(rid);
      });

    return snapshot(run);
  }

  async getRun(rid: string): Promise<InvokeRunSnapshot> {
    const run = this.runs.get(rid);
    if (!run) {
      throw new BadRequestException(`Run not found: ${rid}`);
    }
    return snapshot(run);
  }

  async cancel(rid: string): Promise<{ rid: string; cancelled: true }> {
    const run = this.runs.get(rid);
    if (run && run.status === "running") {
      run.status = "cancelled";
    }
    await this.invocations.cancel(rid);
    return { rid, cancelled: true };
  }
}

export type InvokeRunStatus = "running" | "completed" | "failed" | "cancelled";

interface InvokeRun {
  rid: string;
  provider: ProviderId;
  status: InvokeRunStatus;
  response?: ProviderResponse;
  error?: BridgeError;
}

export interface InvokeRunSnapshot {
  rid: string;
  provider: ProviderId;
  status: InvokeRunStatus;
  response?: ProviderResponse;
  error?: BridgeError;
}

function snapshot(run: InvokeRun): InvokeRunSnapshot {
  return {
    rid: run.rid,
    provider: run.provider,
    status: run.status,
    response: run.response,
    error: run.error
  };
}

function toBridgeError(error: unknown, provider: ProviderId): BridgeError {
  return {
    code: "INVOKE_FAILED",
    message: error instanceof Error ? error.message : String(error),
    provider
  };
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
