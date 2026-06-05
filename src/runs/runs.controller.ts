import { Body, Controller, Delete, Get, Headers, Param, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { RunsService, type RunEvent, type RunSnapshot } from "./runs.service.js";

@Controller("runs")
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post()
  create(@Body() body: unknown): RunSnapshot {
    return this.runs.create(body);
  }

  @Get(":id")
  get(@Param("id") id: string): RunSnapshot {
    return this.runs.get(id);
  }

  @Delete(":id")
  async cancel(@Param("id") id: string): Promise<RunSnapshot> {
    return await this.runs.cancel(id);
  }

  @Get(":id/events")
  async events(
    @Param("id") id: string,
    @Headers("last-event-id") lastEventId: string | undefined,
    @Res() reply: FastifyReply
  ): Promise<void> {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    let closed = false;
    let unsubscribe = (): void => undefined;
    let resolvePending: (() => void) | undefined;

    const close = (): void => {
      closed = true;
      unsubscribe();
      resolvePending?.();
    };
    reply.raw.on("close", close);

    const parsedLastEventId = parseLastEventId(lastEventId);
    for (const event of this.runs.eventsSince(id, parsedLastEventId)) {
      writeRunEvent(reply, event);
    }

    const snapshot = this.runs.get(id);
    if (isTerminal(snapshot.status)) {
      reply.raw.off("close", close);
      reply.raw.end();
      return;
    }

    await new Promise<void>((resolve) => {
      resolvePending = resolve;
      unsubscribe = this.runs.subscribe(id, (event) => {
        if (closed) {
          resolve();
          return;
        }
        writeRunEvent(reply, event);
        if (event.event === "done" || event.event === "error") {
          resolve();
        }
      });
    });

    unsubscribe();
    resolvePending = undefined;
    reply.raw.off("close", close);
    if (!closed) {
      reply.raw.end();
    }
  }
}

function writeRunEvent(reply: FastifyReply, event: RunEvent): void {
  reply.raw.write(
    `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
  );
}

function parseLastEventId(raw: string | undefined): number {
  if (!raw) {
    return 0;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isTerminal(status: RunSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
