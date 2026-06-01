import { Inject, Injectable, Optional } from "@nestjs/common";
import { Codex, type CodexOptions, type Input, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import { BaseProvider } from "./base-provider.js";
import type {
  ProviderCapabilities,
  ProviderInfo,
  ProviderRequest,
  StreamEvent
} from "../core/types.js";
import { ProcessRunnerService } from "../process/process-runner.service.js";
import { resolvePackageVersion } from "./package-version.js";
import { createCodexEventNormalizer } from "./codex-normalizer.js";

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export interface CodexThreadLike {
  runStreamed(
    input: Input,
    turnOptions?: Record<string, unknown>
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}

export type CodexClientFactory = (options?: CodexOptions) => CodexClientLike;
export const CODEX_CLIENT_FACTORY = Symbol("CODEX_CLIENT_FACTORY");

@Injectable()
export class CodexProvider extends BaseProvider {
  readonly id = "codex" as const;
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly processRunner: ProcessRunnerService,
    @Optional()
    @Inject(CODEX_CLIENT_FACTORY)
    private readonly codexFactory: CodexClientFactory = (options) => new Codex(options)
  ) {
    super();
  }

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      displayName: "OpenAI Codex",
      streaming: true,
      cancel: "abort-signal",
      nativeSession: true,
      tools: { builtin: true, mcp: true, hostProvided: false },
      input: { text: true, localImage: true, asyncMessages: false }
    };
  }

  async detect(): Promise<ProviderInfo> {
    const diagnostics: string[] = [];
    let sdkVersion: string | undefined;

    try {
      sdkVersion = resolvePackageVersion("@openai/codex-sdk");
    } catch (error) {
      diagnostics.push(`SDK import failed: ${String(error)}`);
    }

    const versionResult = await this.processRunner.run("codex", ["--version"], {
      timeoutMs: 3000
    });

    if (versionResult.exitCode !== 0) {
      diagnostics.push(versionResult.stderr || "codex --version failed");
    }

    let authStatus: ProviderInfo["authStatus"] = "missing";
    if (versionResult.exitCode === 0) {
      const authResult = await this.processRunner.run("codex", ["login", "status"], {
        timeoutMs: 3000
      });
      if (authResult.exitCode === 0) {
        authStatus = "configured";
      } else {
        diagnostics.push(
          `codex login status failed: ${authResult.stderr || authResult.stdout || "unknown error"}`
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
      executable: "codex",
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
    const abortController = new AbortController();
    this.abortControllers.set(requestId, abortController);

    if (request.signal) {
      request.signal.addEventListener("abort", () => abortController.abort(), {
        once: true
      });
    }

    try {
      const codex = this.codexFactory({
        ...(request.nativeOptions?.codexOptions as Record<string, unknown> | undefined)
      });
      const thread = this.createThread(codex, request);
      const streamed = await thread.runStreamed(toCodexInput(request.input), {
        signal: abortController.signal,
        ...(request.nativeOptions?.turnOptions as Record<string, unknown> | undefined)
      });
      const normalizeCodexEvent = createCodexEventNormalizer(
        requestId,
        request.session
      );

      for await (const event of streamed.events) {
        for (const normalized of normalizeCodexEvent(event)) {
          yield normalized;
        }
      }
    } catch (error) {
      yield {
        type: "error",
        requestId,
        timestamp: new Date().toISOString(),
        error: {
          code: abortController.signal.aborted ? "PROVIDER_CANCELLED" : "PROVIDER_ERROR",
          message: error instanceof Error ? error.message : String(error),
          provider: this.id
        }
      };
    } finally {
      this.abortControllers.delete(requestId);
    }
  }

  override async cancel(requestId: string): Promise<void> {
    this.abortControllers.get(requestId)?.abort();
    this.abortControllers.delete(requestId);
  }

  private createThread(codex: CodexClientLike, request: ProviderRequest): CodexThreadLike {
    const threadOptions: ThreadOptions = {
      workingDirectory: request.cwd,
      model: request.model,
      ...(request.nativeOptions?.threadOptions as Record<string, unknown> | undefined)
    };

    if (request.session) {
      return codex.resumeThread(request.session, threadOptions);
    }

    return codex.startThread(threadOptions);
  }
}

function toCodexInput(input: ProviderRequest["input"]): Input {
  return input;
}
