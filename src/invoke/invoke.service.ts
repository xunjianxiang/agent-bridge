import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { BridgeError, ProviderId, ProviderRequest, ProviderResponse } from "../core/types.js";
import { providerRequestSchema } from "../core/request.schema.js";
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

    const requestId = `inv_${randomUUID()}`;
    const provider = this.providers.get(parsed.data.provider);
    const handle = this.invocations.create(requestId, provider.id, () =>
      provider.cancel(requestId)
    );

    const request: ProviderRequest = {
      ...parsed.data,
      signal: handle.abortController.signal
    };

    try {
      return await provider.invoke(requestId, request);
    } finally {
      this.invocations.delete(requestId);
    }
  }

  start(payload: unknown): InvokeRunSnapshot {
    const parsed = providerRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    const requestId = `inv_${randomUUID()}`;
    const provider = this.providers.get(parsed.data.provider);
    const handle = this.invocations.create(requestId, provider.id, () =>
      provider.cancel(requestId)
    );
    const request: ProviderRequest = {
      ...parsed.data,
      signal: handle.abortController.signal
    };
    const run: InvokeRun = {
      requestId,
      provider: provider.id,
      status: "running"
    };
    this.runs.set(requestId, run);

    void provider
      .invoke(requestId, request)
      .then((response) => {
        const current = this.runs.get(requestId);
        if (!current || current.status === "cancelled") {
          return;
        }
        current.status = "completed";
        current.response = response;
      })
      .catch((error) => {
        const current = this.runs.get(requestId);
        if (!current || current.status === "cancelled") {
          return;
        }
        current.status = handle.abortController.signal.aborted ? "cancelled" : "failed";
        current.error = toBridgeError(error, provider.id);
      })
      .finally(() => {
        this.invocations.delete(requestId);
      });

    return snapshot(run);
  }

  async getRun(requestId: string): Promise<InvokeRunSnapshot> {
    const run = this.runs.get(requestId);
    if (!run) {
      throw new BadRequestException(`Run not found: ${requestId}`);
    }
    return snapshot(run);
  }

  async cancel(requestId: string): Promise<{ requestId: string; cancelled: true }> {
    const run = this.runs.get(requestId);
    if (run && run.status === "running") {
      run.status = "cancelled";
    }
    await this.invocations.cancel(requestId);
    return { requestId, cancelled: true };
  }
}

export type InvokeRunStatus = "running" | "completed" | "failed" | "cancelled";

interface InvokeRun {
  requestId: string;
  provider: ProviderId;
  status: InvokeRunStatus;
  response?: ProviderResponse;
  error?: BridgeError;
}

export interface InvokeRunSnapshot {
  requestId: string;
  provider: ProviderId;
  status: InvokeRunStatus;
  response?: ProviderResponse;
  error?: BridgeError;
}

function snapshot(run: InvokeRun): InvokeRunSnapshot {
  return {
    requestId: run.requestId,
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
