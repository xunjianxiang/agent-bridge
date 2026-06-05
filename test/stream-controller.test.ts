import { describe, expect, it } from "vitest";
import { StreamController } from "../src/stream/stream.controller.js";
import type { StreamEvent } from "../src/core/types.js";

describe("StreamController", () => {
  it("writes a started event before provider stream events", async () => {
    const writes: string[] = [];
    const provider = {
      id: "codex",
      async *stream(rid: string): AsyncIterable<StreamEvent> {
        yield {
          type: "done",
          rid,
          provider: "codex",
          response: { rid, provider: "codex" },
          timestamp: "2026-06-02T00:00:00.000Z"
        };
      },
      cancel: async () => undefined
    };
    const controller = new StreamController(
      { get: () => provider } as never,
      {
        create: (rid: string) => ({
          rid,
          provider: "codex",
          abortController: new AbortController()
        }),
        delete: () => undefined,
        cancel: async () => undefined
      } as never
    );
    const reply = {
      raw: {
        writeHead: () => undefined,
        on: () => undefined,
        off: () => undefined,
        write: (chunk: string) => writes.push(chunk),
        end: () => undefined
      }
    };

    await controller.stream({ provider: "codex", input: "ping" }, reply as never);

    expect(writes[0]).toContain("event: started");
    expect(JSON.parse(writes[0].split("data: ")[1])).toMatchObject({
      type: "started",
      provider: "codex"
    });
    expect(writes[1]).toContain("event: done");
  });
});
