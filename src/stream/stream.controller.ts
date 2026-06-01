import { BadRequestException, Body, Controller, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { providerRequestSchema } from "../core/request.schema.js";
import type { ProviderRequest, StreamEvent } from "../core/types.js";
import { InvocationRegistryService } from "../invoke/invocation-registry.service.js";
import { ProviderRegistry } from "../providers/provider.registry.js";
import { formatSseEvent } from "./sse.js";

@Controller()
export class StreamController {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly invocations: InvocationRegistryService
  ) {}

  @Post("stream")
  async stream(
    @Body() body: unknown,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const parsed = providerRequestSchema.safeParse(body);
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

    let completed = false;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const onClose = (): void => {
      if (!completed) {
        void this.invocations.cancel(requestId);
      }
    };
    reply.raw.on("close", onClose);

    try {
      for await (const event of provider.stream(requestId, request)) {
        this.write(reply, event);
      }
    } catch (error) {
      this.write(reply, {
        type: "error",
        requestId,
        timestamp: new Date().toISOString(),
        error: {
          code: "STREAM_FAILED",
          message: error instanceof Error ? error.message : String(error),
          provider: provider.id
        }
      });
    } finally {
      completed = true;
      reply.raw.off("close", onClose);
      this.invocations.delete(requestId);
      reply.raw.end();
    }
  }

  private write(reply: FastifyReply, event: StreamEvent): void {
    reply.raw.write(formatSseEvent(event));
  }
}
