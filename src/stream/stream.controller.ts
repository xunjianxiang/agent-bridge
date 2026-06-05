import { BadRequestException, Body, Controller, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { providerRequestSchema } from "../core/request.schema.js";
import { createRid } from "../core/rid.js";
import type { ProviderRequest, StreamEvent } from "../core/types.js";
import { resolveProjectCwd } from "../core/workspace.js";
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

    const rid = createRid();
    const provider = this.providers.get(parsed.data.provider);
    const handle = this.invocations.create(rid, provider.id, () =>
      provider.cancel(rid)
    );
    const request: ProviderRequest = toProviderRequest(
      parsed.data,
      handle.abortController.signal
    );

    let completed = false;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const onClose = (): void => {
      if (!completed) {
        void this.invocations.cancel(rid);
      }
    };
    reply.raw.on("close", onClose);

    try {
      this.write(reply, {
        type: "started",
        rid,
        provider: provider.id,
        timestamp: new Date().toISOString()
      });
      for await (const event of provider.stream(rid, request)) {
        this.write(reply, event);
      }
    } catch (error) {
      this.write(reply, {
        type: "error",
        rid,
        provider: provider.id,
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
      this.invocations.delete(rid);
      reply.raw.end();
    }
  }

  private write(reply: FastifyReply, event: StreamEvent | { type: "started"; rid: string; provider: ProviderRequest["provider"]; timestamp: string }): void {
    reply.raw.write(formatSseEvent(event));
  }
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
