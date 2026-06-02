import { Injectable, NotFoundException } from "@nestjs/common";

import type { ProviderId } from "../core/types.js";

export interface InvocationHandle {
  rid: string;
  provider: ProviderId;
  abortController: AbortController;
  cancel?: () => Promise<void>;
}

@Injectable()
export class InvocationRegistryService {
  private readonly active = new Map<string, InvocationHandle>();

  create(
    rid: string,
    provider: ProviderId,
    cancel?: () => Promise<void>
  ): InvocationHandle {
    const handle: InvocationHandle = {
      rid,
      provider,
      abortController: new AbortController(),
      cancel
    };
    this.active.set(rid, handle);
    return handle;
  }

  get(rid: string): InvocationHandle {
    const handle = this.active.get(rid);
    if (!handle) {
      throw new NotFoundException(`Invocation not found: ${rid}`);
    }
    return handle;
  }

  delete(rid: string): void {
    this.active.delete(rid);
  }

  async cancel(rid: string): Promise<void> {
    const handle = this.get(rid);
    handle.abortController.abort();
    if (handle.cancel) {
      await handle.cancel();
    }
    this.delete(rid);
  }
}
