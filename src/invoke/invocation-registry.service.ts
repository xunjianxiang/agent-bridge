import { Injectable, NotFoundException } from "@nestjs/common";

import type { ProviderId } from "../core/types.js";

export interface InvocationHandle {
  requestId: string;
  provider: ProviderId;
  abortController: AbortController;
  cancel?: () => Promise<void>;
}

@Injectable()
export class InvocationRegistryService {
  private readonly active = new Map<string, InvocationHandle>();

  create(
    requestId: string,
    provider: ProviderId,
    cancel?: () => Promise<void>
  ): InvocationHandle {
    const handle: InvocationHandle = {
      requestId,
      provider,
      abortController: new AbortController(),
      cancel
    };
    this.active.set(requestId, handle);
    return handle;
  }

  get(requestId: string): InvocationHandle {
    const handle = this.active.get(requestId);
    if (!handle) {
      throw new NotFoundException(`Invocation not found: ${requestId}`);
    }
    return handle;
  }

  delete(requestId: string): void {
    this.active.delete(requestId);
  }

  async cancel(requestId: string): Promise<void> {
    const handle = this.get(requestId);
    handle.abortController.abort();
    if (handle.cancel) {
      await handle.cancel();
    }
    this.delete(requestId);
  }
}
