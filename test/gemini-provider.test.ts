import { Readable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "../src/providers/gemini.provider.js";
import type { ProcessRunnerService } from "../src/process/process-runner.service.js";

function childFromJsonLines(lines: unknown[]): ChildProcessWithoutNullStreams {
  return {
    stdout: Readable.from(lines.map((line) => `${JSON.stringify(line)}\n`)),
    stderr: Readable.from([]),
    on(event: string, listener: (exitCode: number) => void) {
      if (event === "close") {
        setImmediate(() => listener(0));
      }
      return this;
    },
    kill: vi.fn()
  } as unknown as ChildProcessWithoutNullStreams;
}

describe("GeminiProvider session handling", () => {
  it("returns the Gemini session id from the init event", async () => {
    const provider = new GeminiProvider({
      spawn: () =>
        childFromJsonLines([
          { type: "init", session_id: "session_new", model: "gemini-test" },
          { type: "message", role: "assistant", content: "pong" },
          { type: "result", status: "success", stats: { output_tokens: 1 } }
        ])
    } as unknown as ProcessRunnerService);

    const response = await provider.invoke("inv_1", {
      provider: "gemini",
      input: "Reply with exactly: pong"
    });

    expect(response.session).toBe("session_new");
    expect(response.finalText).toBe("pong");
  });

  it("passes the native session id to Gemini CLI resume", async () => {
    const spawn = vi.fn(() =>
      childFromJsonLines([
        { type: "init", session_id: "session_existing", model: "gemini-test" },
        { type: "message", role: "assistant", content: "resumed" },
        { type: "result", status: "success", stats: { output_tokens: 1 } }
      ])
    );
    const provider = new GeminiProvider({ spawn } as unknown as ProcessRunnerService);

    await provider.invoke("inv_1", {
      provider: "gemini",
      input: "Continue",
      session: "session_existing"
    });

    expect(spawn).toHaveBeenCalledWith(
      "gemini",
      expect.arrayContaining(["--resume", "session_existing"]),
      expect.any(Object)
    );
  });
});
