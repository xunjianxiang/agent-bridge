import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunnerService } from "../src/process/process-runner.service.js";

describe("ProcessRunnerService", () => {
  it("preserves arguments containing spaces", async () => {
    const runner = new ProcessRunnerService();

    const result = await runner.run(process.execPath, [
      "-e",
      "console.log(process.argv[1])",
      "hello world"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("runs Windows command shims while preserving spaced arguments", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const shim = join(dir, "echo-arg.cmd");
    writeFileSync(shim, "@echo off\r\necho %~1\r\n", "utf8");
    const runner = new ProcessRunnerService();

    const result = await runner.run(shim, ["hello world"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("returns when a command exceeds its timeout", async () => {
    const runner = new ProcessRunnerService();
    const started = Date.now();

    const result = await runner.run(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      { timeoutMs: 50 }
    );

    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("timed out after 50ms");
  });
});
