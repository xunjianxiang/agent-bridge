import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ProviderRequest, ProviderResponse } from "../core/types.js";
import { providerRequestSchema } from "../core/request.schema.js";
import { ProviderRegistry } from "../providers/provider.registry.js";
import { InvocationRegistryService } from "./invocation-registry.service.js";

@Injectable()
export class InvokeService {
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

  async cancel(requestId: string): Promise<{ requestId: string; cancelled: true }> {
    await this.invocations.cancel(requestId);
    return { requestId, cancelled: true };
  }
}
