import { Injectable } from "@nestjs/common";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

@Injectable()
export class ProcessRunnerService {
  async run(
    command: string,
    args: string[] = [],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
  ): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve) => {
      const commandSpec = resolveCommand(command, args);
      const child = spawn(commandSpec.command, commandSpec.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const settle = (result: CommandResult) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve(result);
      };

      if (options.timeoutMs) {
        timer = setTimeout(() => {
          if (!settled) {
            const timeoutMessage = `${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`;
            terminateProcessTree(child);
            settle({
              exitCode: null,
              stdout,
              stderr: appendStderr(stderr, timeoutMessage)
            });
          }
        }, options.timeoutMs);
      }

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("close", (exitCode) => {
        settle({ exitCode, stdout, stderr });
      });

      child.on("error", (error) => {
        settle({ exitCode: null, stdout, stderr: appendStderr(stderr, error.message) });
      });
    });
  }

  spawn(
    command: string,
    args: string[] = [],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
  ): ChildProcessWithoutNullStreams {
    const commandSpec = resolveCommand(command, args);
    return spawn(commandSpec.command, commandSpec.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false
    });
  }
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    return;
  }

  child.kill();
}

function appendStderr(stderr: string, message: string): string {
  return stderr ? `${stderr.trimEnd()}\n${message}` : message;
}

function resolveCommand(
  command: string,
  args: string[]
): { command: string; args: string[] } {
  const executable = resolveExecutable(command);
  if (process.platform === "win32" && [".cmd", ".bat"].includes(extname(executable))) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/c", executable, ...args]
    };
  }

  return { command: executable, args };
}

function resolveExecutable(command: string): string {
  if (process.platform !== "win32" || extname(command)) {
    return command;
  }

  const pathEntries = process.env.PATH?.split(";") ?? [];
  for (const entry of pathEntries) {
    for (const extension of [".cmd", ".exe", ".bat"]) {
      const candidate = join(entry, `${command}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const extensionless = join(entry, command);
    if (existsSync(extensionless) && dirname(extensionless) === entry) {
      return extensionless;
    }
  }

  return command;
}
