import { Injectable } from "@nestjs/common";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { BaseProvider } from "./base-provider.js";
import type {
  ProviderCapabilities,
  ProviderInfo,
  ProviderRequest,
  StreamEvent
} from "../core/types.js";
import { ProcessRunnerService } from "../process/process-runner.service.js";
import { parseJsonLines } from "../stream/jsonl.js";
import { resolvePackageVersion } from "./package-version.js";

@Injectable()
export class GeminiProvider extends BaseProvider {
  readonly id = "gemini" as const;
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(private readonly processRunner: ProcessRunnerService) {
    super();
  }

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      displayName: "Gemini CLI",
      streaming: true,
      cancel: "process-kill",
      nativeSession: true,
      tools: { builtin: true, mcp: true, hostProvided: false },
      input: { text: true, localImage: false, asyncMessages: false }
    };
  }

  async detect(): Promise<ProviderInfo> {
    const diagnostics: string[] = [];
    let sdkVersion: string | undefined;

    try {
      sdkVersion = resolvePackageVersion("@google/gemini-cli-core");
    } catch (error) {
      diagnostics.push(`SDK import failed: ${String(error)}`);
    }

    const versionResult = await this.processRunner.run("gemini", ["--version"], {
      timeoutMs: 10000
    });

    if (versionResult.exitCode !== 0) {
      diagnostics.push(versionResult.stderr || "gemini --version failed");
    }

    let authStatus: ProviderInfo["authStatus"] = "missing";
    if (versionResult.exitCode === 0) {
      const authResult = await this.processRunner.run("gemini", ["--list-sessions"], {
        timeoutMs: 15000
      });
      if (authResult.exitCode === 0) {
        authStatus = "configured";
      } else {
        diagnostics.push(
          `gemini --list-sessions failed: ${authResult.stderr || authResult.stdout || "unknown error"}`
        );
      }
    }

    const status: ProviderInfo["status"] =
      !sdkVersion || versionResult.exitCode !== 0
        ? "missing"
        : authStatus === "configured"
          ? "available"
          : "misconfigured";

    return this.info(status, {
      executable: "gemini",
      version: versionResult.stdout.trim() || undefined,
      sdkVersion,
      authStatus,
      diagnostics
    });
  }

  async *stream(
    requestId: string,
    request: ProviderRequest
  ): AsyncIterable<StreamEvent> {
    if (typeof request.input !== "string") {
      yield {
        type: "error",
        requestId,
        timestamp: new Date().toISOString(),
        error: {
          code: "UNSUPPORTED_INPUT",
          message: "Gemini CLI adapter currently accepts string input only.",
          provider: this.id
        }
      };
      return;
    }

    const args = [
      "-p",
      request.input,
      "--output-format",
      "stream-json",
      ...(request.session ? ["--resume", request.session] : []),
      ...(request.model ? ["-m", request.model] : [])
    ];
    const child = this.processRunner.spawn("gemini", args, {
      cwd: request.cwd,
      env: process.env
    });
    this.processes.set(requestId, child);

    const stderrTask = this.collectStderr(requestId, child);

    try {
      let session = request.session;
      for await (const line of parseJsonLines(child.stdout)) {
        if (line.error) {
          yield {
            type: "stdout",
            requestId,
            data: line.raw,
            timestamp: new Date().toISOString(),
            raw: { parseError: line.error.message }
          };
          continue;
        }

        const rawEvent = line.value as { type?: string; session_id?: string };
        if (rawEvent.type === "init" && rawEvent.session_id) {
          session = rawEvent.session_id;
        }

        const event = this.normalizeGeminiEvent(requestId, line.value);
        if (event.type === "done") {
          yield {
            ...event,
            response: {
              ...event.response,
              session: event.response.session ?? session
            }
          };
          continue;
        }

        yield event;
      }

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("close", resolve);
      });

      const stderr = await stderrTask;
      if (stderr) {
        yield {
          type: "stderr",
          requestId,
          data: stderr,
          timestamp: new Date().toISOString()
        };
      }

      if (exitCode !== 0) {
        yield {
          type: "error",
          requestId,
          timestamp: new Date().toISOString(),
          error: {
            code: "PROVIDER_PROCESS_EXITED",
            message: `Gemini exited with code ${exitCode ?? "unknown"}.`,
            provider: this.id,
            details: { stderr }
          }
        };
      }
    } finally {
      this.processes.delete(requestId);
    }
  }

  override async cancel(requestId: string): Promise<void> {
    const child = this.processes.get(requestId);
    if (child) {
      child.kill();
      this.processes.delete(requestId);
    }
  }

  private normalizeGeminiEvent(requestId: string, raw: unknown): StreamEvent {
    const event = raw as {
      type?: string;
      message?: string;
      content?: string;
      role?: "user" | "assistant";
      session_id?: string;
      model?: string;
      tool_name?: string;
      tool_id?: string;
      parameters?: Record<string, unknown>;
      status?: "success" | "error";
      output?: string;
      error?: { type?: string; message?: string };
      stats?: Record<string, unknown>;
    };
    const timestamp = new Date().toISOString();

    switch (event.type) {
      case "init":
        return {
          type: "message",
          requestId,
          role: "system",
          content: `Gemini session initialized${event.model ? ` with ${event.model}` : ""}.`,
          timestamp,
          raw
        };
      case "message":
        return {
          type: "message",
          requestId,
          role: event.role ?? "assistant",
          delta: event.content,
          timestamp,
          raw
        };
      case "tool_use":
        return {
          type: "tool_call",
          requestId,
          toolCallId: event.tool_id ?? "unknown",
          name: event.tool_name ?? "unknown",
          args: event.parameters,
          status: "started",
          timestamp,
          raw
        };
      case "tool_result":
        return {
          type: "tool_result",
          requestId,
          toolCallId: event.tool_id ?? "unknown",
          status: event.status === "success" ? "success" : "error",
          output: event.output,
          error: event.error
            ? {
                code: event.error.type ?? "TOOL_ERROR",
                message: event.error.message ?? "Gemini tool failed.",
                provider: this.id
              }
            : undefined,
          timestamp,
          raw
        };
      case "error":
        return {
          type: "error",
          requestId,
          error: {
            code: event.error?.type ?? "PROVIDER_ERROR",
            message: event.message ?? event.error?.message ?? "Gemini failed.",
            provider: this.id
          },
          timestamp,
          raw
        };
      case "result":
        return {
          type: "done",
          requestId,
          response: {
            requestId,
            provider: this.id,
            session: event.session_id,
            usage: event.stats,
            raw
          },
          timestamp
        };
      default:
        return {
          type: "stdout",
          requestId,
          data: JSON.stringify(raw),
          timestamp,
          raw
        };
    }
  }

  private async collectStderr(
    _requestId: string,
    child: ChildProcessWithoutNullStreams
  ): Promise<string> {
    let stderr = "";
    for await (const chunk of child.stderr) {
      stderr += Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
    }
    return stderr.trim();
  }
}
