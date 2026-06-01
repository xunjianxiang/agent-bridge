import { Injectable } from "@nestjs/common";
import { BaseProvider } from "./base-provider.js";
import type {
  ProviderCapabilities,
  ProviderInfo,
  ProviderRequest,
  StreamEvent
} from "../core/types.js";
import { ProcessRunnerService } from "../process/process-runner.service.js";
import { resolvePackageVersion } from "./package-version.js";

@Injectable()
export class ClaudeProvider extends BaseProvider {
  readonly id = "claude" as const;

  constructor(private readonly processRunner: ProcessRunnerService) {
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
    requestId: string,
    _request: ProviderRequest
  ): AsyncIterable<StreamEvent> {
    yield {
      type: "error",
      requestId,
      timestamp: new Date().toISOString(),
      error: {
        code: "NOT_IMPLEMENTED",
        message: "Claude invocation is not implemented yet.",
        provider: this.id
      }
    };
  }
}
