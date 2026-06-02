import { Inject, Injectable, Optional } from "@nestjs/common";
import { query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BaseProvider } from "./base-provider.js";
import type {
  ProviderCapabilities,
  ProviderInfo,
  ProviderRequest,
  StreamEvent
} from "../core/types.js";
import { ProcessRunnerService } from "../process/process-runner.service.js";
import { resolvePackageVersion } from "./package-version.js";

export type ClaudeQuery = typeof query;
export const CLAUDE_QUERY = Symbol("CLAUDE_QUERY");

@Injectable()
export class ClaudeProvider extends BaseProvider {
  readonly id = "claude" as const;
  private readonly queries = new Map<string, Query>();

  constructor(
    private readonly processRunner: ProcessRunnerService,
    @Optional()
    @Inject(CLAUDE_QUERY)
    private readonly claudeQuery: ClaudeQuery = query
  ) {
    super();
  }

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      displayName: "Claude Agent",
      streaming: true,
      cancel: "interrupt",
      nativeSession: true,
      tools: { builtin: true, mcp: true, hostProvided: true },
      input: { text: true, localImage: false, asyncMessages: true }
    };
  }

  async detect(): Promise<ProviderInfo> {
    const diagnostics: string[] = [];
    let sdkVersion: string | undefined;

    try {
      sdkVersion = resolvePackageVersion("@anthropic-ai/claude-agent-sdk");
    } catch (error) {
      diagnostics.push(`SDK import failed: ${String(error)}`);
    }

    const versionResult = await this.processRunner.run("claude", ["--version"], {
      timeoutMs: 3000
    });

    if (versionResult.exitCode !== 0) {
      diagnostics.push(versionResult.stderr || "claude --version failed");
    }

    let authStatus: ProviderInfo["authStatus"] = "missing";
    if (versionResult.exitCode === 0) {
      const authResult = await this.processRunner.run("claude", ["auth", "status"], {
        timeoutMs: 3000
      });
      if (authResult.exitCode === 0) {
        authStatus = "configured";
      } else {
        diagnostics.push(
          `claude auth status failed: ${authResult.stderr || authResult.stdout || "unknown error"}`
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
      executable: "claude",
      version: versionResult.stdout.trim() || undefined,
      sdkVersion,
      authStatus,
      diagnostics
    });
  }

  async *stream(
    rid: string,
    request: ProviderRequest
  ): AsyncIterable<StreamEvent> {
    if (typeof request.input !== "string") {
      yield {
        type: "error",
        rid,
        timestamp: new Date().toISOString(),
        error: {
          code: "UNSUPPORTED_INPUT",
          message: "Claude Agent SDK adapter currently accepts string input only.",
          provider: this.id
        }
      };
      return;
    }

    const abortController = new AbortController();
    if (request.signal) {
      request.signal.addEventListener("abort", () => abortController.abort(), {
        once: true
      });
    }

    const claude = this.claudeQuery({
      prompt: request.input,
      options: this.options(request, abortController)
    });
    this.queries.set(rid, claude);

    try {
      for await (const message of claude) {
        yield this.normalizeMessage(rid, message);
      }
    } catch (error) {
      yield {
        type: "error",
        rid,
        timestamp: new Date().toISOString(),
        error: {
          code: abortController.signal.aborted ? "PROVIDER_CANCELLED" : "PROVIDER_ERROR",
          message: error instanceof Error ? error.message : String(error),
          provider: this.id
        }
      };
    } finally {
      this.queries.delete(rid);
    }
  }

  override async cancel(rid: string): Promise<void> {
    this.queries.get(rid)?.close();
    this.queries.delete(rid);
  }

  private options(request: ProviderRequest, abortController: AbortController): Options {
    return {
      cwd: request.cwd,
      model: request.model,
      resume: request.session,
      abortController,
      ...(request.options?.claudeOptions as Record<string, unknown> | undefined)
    };
  }

  private normalizeMessage(rid: string, message: SDKMessage): StreamEvent {
    const timestamp = new Date().toISOString();

    if (message.type === "assistant") {
      return {
        type: "message",
        rid,
        role: "assistant",
        delta: assistantText(message),
        raw: message,
        timestamp
      };
    }

    if (message.type === "result") {
      if (message.subtype === "success") {
        return {
          type: "done",
          rid,
          response: {
            rid,
            provider: this.id,
            session: message.session_id,
            output: message.result,
            usage: {
              durationMs: message.duration_ms,
              durationApiMs: message.duration_api_ms,
              totalCostUsd: message.total_cost_usd,
              usage: message.usage,
              modelUsage: message.modelUsage
            },
            raw: message
          },
          timestamp
        };
      }

      return {
        type: "error",
        rid,
        error: {
          code: "PROVIDER_ERROR",
          message: message.errors.join("\n") || "Claude failed.",
          provider: this.id,
          details: message
        },
        raw: message,
        timestamp
      };
    }

    if (message.type === "system" && message.subtype === "init") {
      return {
        type: "message",
        rid,
        role: "system",
        content: `Claude session initialized with ${message.model}.`,
        raw: message,
        timestamp
      };
    }

    if (message.type === "auth_status") {
      return {
        type: "stderr",
        rid,
        data: message.error ?? message.output.join("\n"),
        raw: message,
        timestamp
      };
    }

    if (message.type === "tool_progress") {
      return {
        type: "tool_call",
        rid,
        toolCallId: message.tool_use_id,
        name: message.tool_name,
        status: "running",
        raw: message,
        timestamp
      };
    }

    return {
      type: "stdout",
      rid,
      data: JSON.stringify(message),
      raw: message,
      timestamp
    };
  }
}

function assistantText(message: Extract<SDKMessage, { type: "assistant" }>): string {
  return message.message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}
