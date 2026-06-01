import { describe, expect, it } from "vitest";
import { ClaudeProvider } from "../src/providers/claude.provider.js";
import { CodexProvider } from "../src/providers/codex.provider.js";
import { GeminiProvider } from "../src/providers/gemini.provider.js";
import type { ProcessRunnerService } from "../src/process/process-runner.service.js";

type RunResult = { exitCode: number | null; stdout: string; stderr: string };

function runner(results: RunResult[]): ProcessRunnerService {
  return {
    run: async () =>
      results.shift() ?? { exitCode: 1, stdout: "", stderr: "unexpected command" }
  } as unknown as ProcessRunnerService;
}

function recordingRunner(results: RunResult[]) {
  const calls: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
  const processRunner = {
    run: async (
      command: string,
      args: string[] = [],
      options: { timeoutMs?: number } = {}
    ) => {
      calls.push({ command, args, timeoutMs: options.timeoutMs });
      return results.shift() ?? { exitCode: 1, stdout: "", stderr: "unexpected command" };
    }
  } as unknown as ProcessRunnerService;
  return { processRunner, calls };
}

describe("provider detection", () => {
  it("marks Codex available only when CLI and auth are configured", async () => {
    const provider = new CodexProvider(
      runner([
        { exitCode: 0, stdout: "codex-cli 0.133.0", stderr: "" },
        { exitCode: 0, stdout: "Logged in using an API key", stderr: "" }
      ])
    );

    const info = await provider.detect();

    expect(info.status).toBe("available");
    expect(info.authStatus).toBe("configured");
  });

  it("marks Codex misconfigured when auth is missing", async () => {
    const provider = new CodexProvider(
      runner([
        { exitCode: 0, stdout: "codex-cli 0.133.0", stderr: "" },
        { exitCode: 1, stdout: "", stderr: "not logged in" }
      ])
    );

    const info = await provider.detect();

    expect(info.status).toBe("misconfigured");
    expect(info.authStatus).toBe("missing");
    expect(info.diagnostics).toContain("codex login status failed: not logged in");
  });

  it("marks Gemini available only when CLI and local auth/session probe work", async () => {
    const provider = new GeminiProvider(
      runner([
        { exitCode: 0, stdout: "0.44.0", stderr: "" },
        { exitCode: 0, stdout: "Available sessions for this project (0)", stderr: "" }
      ])
    );

    const info = await provider.detect();

    expect(info.status).toBe("available");
    expect(info.authStatus).toBe("configured");
  });

  it("allows Gemini CLI version detection enough time to exit cleanly", async () => {
    const { processRunner, calls } = recordingRunner([
      { exitCode: 0, stdout: "0.44.0", stderr: "" },
      { exitCode: 0, stdout: "Available sessions for this project (0)", stderr: "" }
    ]);
    const provider = new GeminiProvider(processRunner);

    await provider.detect();

    expect(calls[0]).toMatchObject({
      command: "gemini",
      args: ["--version"],
      timeoutMs: 10000
    });
  });

  it("marks Claude missing when the CLI is not installed even if the SDK is present", async () => {
    const provider = new ClaudeProvider(
      runner([{ exitCode: null, stdout: "", stderr: "command not found" }])
    );

    const info = await provider.detect();

    expect(info.status).toBe("missing");
    expect(info.authStatus).toBe("missing");
  });
});
