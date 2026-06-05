import { Inject, Injectable, Optional } from "@nestjs/common";
import { Codex, type CodexOptions, type Input, type ThreadEvent, type ThreadOptions, type Usage } from "@openai/codex-sdk";
import { existsSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { BaseProvider } from "./base-provider.js";
import type {
  ProviderCapabilities,
  ProviderInfo,
  ProviderRequest,
  StreamEvent
} from "../core/types.js";
import { ProcessRunnerService } from "../process/process-runner.service.js";
import { resolvePackageVersion } from "./package-version.js";

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

    const codexExecutable = resolveLocalCodexPathOverride() ?? "codex";
    const versionResult = await this.processRunner.run(codexExecutable, ["--version"], {
      timeoutMs: 3000
    });

    if (versionResult.exitCode !== 0) {
      diagnostics.push(versionResult.stderr || "codex --version failed");
    }

    let authStatus: ProviderInfo["authStatus"] = "missing";
    if (versionResult.exitCode === 0) {
      const authResult = await this.processRunner.run(codexExecutable, ["login", "status"], {
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
    rid: string,
    request: ProviderRequest
  ): AsyncIterable<StreamEvent> {
    const abortController = new AbortController();
    this.abortControllers.set(rid, abortController);

    if (request.signal) {
      request.signal.addEventListener("abort", () => abortController.abort(), {
        once: true
      });
    }

    try {
      const codex = this.codexFactory({
        ...codexClientOptions(request.options?.codexOptions as CodexOptions | undefined)
      });
      const thread = this.createThread(codex, request);
      const streamed = await thread.runStreamed(toCodexInput(request.input), {
        signal: abortController.signal,
        ...(request.options?.turnOptions as Record<string, unknown> | undefined)
      });
      let session = request.session;
      let output = "";

      for await (const event of streamed.events) {
        const timestamp = new Date().toISOString();
        if (event.type === "thread.started") {
          session = event.thread_id;
        }
        if (
          event.type === "item.completed" &&
          event.item.type === "agent_message"
        ) {
          output += event.item.text;
        }

        yield {
          type: "event",
          rid,
          provider: this.id,
          event,
          timestamp
        };

        if (event.type === "turn.completed") {
          yield {
            type: "done",
            rid,
            provider: this.id,
            response: {
              rid,
              provider: this.id,
              session,
              output,
              usage: codexUsageToRecord(event.usage),
              raw: event
            },
            event,
            timestamp: new Date().toISOString()
          };
          return;
        }

        if (event.type === "turn.failed") {
          yield {
            type: "error",
            rid,
            provider: this.id,
            error: {
              code: "PROVIDER_TURN_FAILED",
              message: event.error.message,
              provider: this.id
            },
            event,
            timestamp: new Date().toISOString()
          };
          return;
        }

        // Codex also emits native `error` events for recoverable stream reconnects.
        // Treat only `turn.failed` or iterator exceptions as terminal failures.
      }
    } catch (error) {
      yield {
        type: "error",
        rid,
        provider: this.id,
        timestamp: new Date().toISOString(),
        error: {
          code: abortController.signal.aborted ? "PROVIDER_CANCELLED" : "PROVIDER_ERROR",
          message: error instanceof Error ? error.message : String(error),
          provider: this.id
        }
      };
    } finally {
      this.abortControllers.delete(rid);
    }
  }

  override async cancel(rid: string): Promise<void> {
    this.abortControllers.get(rid)?.abort();
    this.abortControllers.delete(rid);
  }

  private createThread(codex: CodexClientLike, request: ProviderRequest): CodexThreadLike {
    const requestedThreadOptions =
      (request.options?.threadOptions as Partial<ThreadOptions> | undefined) ?? {};
    const {
      workingDirectory: _ignoredWorkingDirectory,
      additionalDirectories: _ignoredAdditionalDirectories,
      ...threadOptionOverrides
    } = requestedThreadOptions;
    const threadOptions: ThreadOptions = {
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      ...threadOptionOverrides,
      workingDirectory: request.cwd,
      model: request.model ?? threadOptionOverrides.model
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

function codexUsageToRecord(usage: Usage): Record<string, unknown> {
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens
  };
}

export function codexClientOptions(overrides: CodexOptions | undefined = {}): CodexOptions {
  return {
    codexPathOverride: resolveLocalCodexPathOverride(),
    ...overrides
  };
}

export function resolveLocalCodexPathOverride(): string | undefined {
  const explicit = process.env.AGENT_BRIDGE_CODEX_PATH?.trim();
  if (explicit) {
    return explicit;
  }

  const commandPath = findPathCommand("codex");
  if (!commandPath) {
    return undefined;
  }

  return resolveNativeCodexFromShim(commandPath) ?? commandPath;
}

function findPathCommand(command: string): string | undefined {
  const pathEntries = process.env.PATH?.split(delimiter) ?? [];
  const extensions =
    process.platform === "win32" ? [".cmd", ".exe", ".bat", ".ps1", ""] : [""];

  for (const entry of pathEntries) {
    if (isProjectPackageBin(entry)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(entry, `${command}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function isProjectPackageBin(pathEntry: string): boolean {
  const normalized = pathEntry.replaceAll("\\", "/").toLowerCase();
  return normalized.endsWith("/node_modules/.bin");
}

function resolveNativeCodexFromShim(commandPath: string): string | undefined {
  if (process.platform !== "win32") {
    return commandPath;
  }

  const extension = extname(commandPath).toLowerCase();
  if (extension === ".exe") {
    return commandPath;
  }

  const basedir = dirname(commandPath);
  const binaryName = "codex.exe";
  const packageRoot = join(basedir, "node_modules", "@openai", "codex");
  const platformPackageRoot = join(
    packageRoot,
    "node_modules",
    "@openai",
    "codex-win32-x64"
  );
  const candidates = [
    join(platformPackageRoot, "vendor", "x86_64-pc-windows-msvc", "bin", binaryName),
    join(platformPackageRoot, "vendor", "x86_64-pc-windows-msvc", "codex", binaryName),
    join(packageRoot, "vendor", "x86_64-pc-windows-msvc", "bin", binaryName),
    join(packageRoot, "vendor", "x86_64-pc-windows-msvc", "codex", binaryName)
  ];

  return candidates.find((candidate) => existsSync(candidate));
}
