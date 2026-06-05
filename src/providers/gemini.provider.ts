import { Inject, Injectable, Optional } from "@nestjs/common";
import { isAbsolute, join } from "node:path";
import {
  AuthType,
  Config,
  DEFAULT_GEMINI_FLASH_MODEL,
  LegacyAgentSession,
  createSessionId,
  loadConversationRecord,
  convertSessionToClientHistory,
  type AgentEvent,
  type AgentSend,
  type ConfigParameters,
  type ConversationRecord,
  type GeminiClient,
  type ResumedSessionData
} from "@google/gemini-cli-core";
import { BaseProvider } from "./base-provider.js";
import type {
  ProviderCapabilities,
  ProviderInfo,
  ProviderRequest,
  StreamEvent
} from "../core/types.js";
import { ProcessRunnerService } from "../process/process-runner.service.js";
import { resolvePackageVersion } from "./package-version.js";

const GEMINI_DETECTION_TIMEOUT_MS = 3000;

export const GEMINI_CORE_CONFIG_FACTORY = Symbol("GEMINI_CORE_CONFIG_FACTORY");
export const GEMINI_CORE_SESSION_FACTORY = Symbol("GEMINI_CORE_SESSION_FACTORY");
export const GEMINI_PROVIDER_DEPS = Symbol("GEMINI_PROVIDER_DEPS");

export interface GeminiCoreConfigLike {
  initialize(): Promise<void>;
  refreshAuth?(
    authMethod: AuthType,
    apiKey?: string,
    baseUrl?: string,
    customHeaders?: Record<string, string>
  ): Promise<void>;
  getSessionId(): string;
  getModel(): string;
  getGeminiClient(): {
    resumeChat?(
      history: readonly unknown[],
      resumedSessionData?: ResumedSessionData
    ): Promise<void>;
  };
  loadSession?(id: string): Promise<ConversationRecord | null>;
  storage?: {
    initialize?(): Promise<void>;
    listProjectChatFiles?(): Promise<Array<{ filePath: string; lastUpdated: string }>>;
    getProjectTempDir?(): string;
  };
}

export interface GeminiCoreSessionLike {
  sendStream(payload: AgentSend): AsyncIterable<AgentEvent>;
  abort(): Promise<void>;
}

export type GeminiCoreConfigFactory = (
  request: ProviderRequest,
  rid: string
) => GeminiCoreConfigLike;
export type GeminiCoreSessionFactory = (deps: {
  config: GeminiCoreConfigLike;
  client: ReturnType<GeminiCoreConfigLike["getGeminiClient"]>;
  streamId?: string;
}) => GeminiCoreSessionLike;

interface GeminiProviderDeps {
  [GEMINI_CORE_CONFIG_FACTORY]?: GeminiCoreConfigFactory;
  [GEMINI_CORE_SESSION_FACTORY]?: GeminiCoreSessionFactory;
}

@Injectable()
export class GeminiProvider extends BaseProvider {
  readonly id = "gemini" as const;
  private readonly sessions = new Map<string, GeminiCoreSessionLike>();

  constructor(
    _processRunner: ProcessRunnerService,
    @Optional()
    @Inject(GEMINI_PROVIDER_DEPS)
    private readonly deps: GeminiProviderDeps = {}
  ) {
    super();
  }

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      displayName: "Gemini CLI Core",
      streaming: true,
      cancel: "abort-signal",
      nativeSession: true,
      tools: { builtin: true, mcp: true, hostProvided: false },
      input: { text: true, localImage: false, asyncMessages: false }
    };
  }

  async detect(): Promise<ProviderInfo> {
    const diagnostics: string[] = [];
    let sdkVersion: string | undefined;
    let authStatus: ProviderInfo["authStatus"] = "missing";

    try {
      sdkVersion = resolvePackageVersion("@google/gemini-cli-core");
    } catch (error) {
      diagnostics.push(`SDK import failed: ${String(error)}`);
    }

    if (sdkVersion) {
      try {
        const config = this.createConfig(
          {
            provider: this.id,
            input: "detect"
          },
          "detect"
        );
        await withTimeout(
          this.prepareConfig(config, {}),
          GEMINI_DETECTION_TIMEOUT_MS,
          `Gemini core initialization timed out after ${GEMINI_DETECTION_TIMEOUT_MS}ms`
        );
        authStatus = "configured";
      } catch (error) {
        diagnostics.push(
          `Gemini core initialization failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const status: ProviderInfo["status"] =
      !sdkVersion ? "missing" : authStatus === "configured" ? "available" : "misconfigured";

    return this.info(status, {
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
        provider: this.id,
        timestamp: new Date().toISOString(),
        error: {
          code: "UNSUPPORTED_INPUT",
          message: "Gemini CLI Core adapter currently accepts string input only.",
          provider: this.id
        }
      };
      return;
    }

    let sessionId = request.session;
    let session: GeminiCoreSessionLike | undefined;
    let output = "";

    try {
      const config = this.createConfig(request, rid);
      await this.prepareAuth(config, request);
      await config.storage?.initialize?.();
      const resumed = request.session ? await this.loadSession(config, request.session) : null;
      await config.initialize();
      await this.resumeSession(config, request.session, resumed);

      sessionId = request.session ?? config.getSessionId();
      session = this.createSession(config, sessionId);
      this.sessions.set(rid, session);

      for await (const event of session.sendStream({
        message: {
          content: [{ type: "text", text: request.input }]
        }
      })) {
        const timestamp = event.timestamp || new Date().toISOString();
        if (event.type === "initialize") {
          sessionId = event.sessionId;
        }
        if (event.type === "message" && event.role === "agent") {
          output += contentText(event.content);
        }

        yield {
          type: "event",
          rid,
          provider: this.id,
          event,
          timestamp
        };

        if (event.type === "agent_end") {
          yield {
            type: "done",
            rid,
            provider: this.id,
            response: {
              rid,
              provider: this.id,
              session: sessionId,
              output,
              usage: event.data,
              raw: event
            },
            event,
            timestamp: new Date().toISOString()
          };
          return;
        }

        if (event.type === "error") {
          yield {
            type: "error",
            rid,
            provider: this.id,
            error: {
              code: event.status,
              message: event.message,
              provider: this.id,
              details: event
            },
            event,
            timestamp: new Date().toISOString()
          };
          return;
        }
      }
    } catch (error) {
      yield {
        type: "error",
        rid,
        provider: this.id,
        timestamp: new Date().toISOString(),
        error: {
          code: "PROVIDER_ERROR",
          message: error instanceof Error ? error.message : String(error),
          provider: this.id
        }
      };
    } finally {
      this.sessions.delete(rid);
    }
  }

  override async cancel(rid: string): Promise<void> {
    const session = this.sessions.get(rid);
    if (session) {
      await session.abort();
      this.sessions.delete(rid);
    }
  }

  private createConfig(
    request: ProviderRequest,
    rid: string
  ): GeminiCoreConfigLike {
    const factory = this.deps[GEMINI_CORE_CONFIG_FACTORY] ?? defaultConfigFactory;
    return factory(request, rid);
  }

  private createSession(
    config: GeminiCoreConfigLike,
    streamId?: string
  ): GeminiCoreSessionLike {
    const factory = this.deps[GEMINI_CORE_SESSION_FACTORY] ?? defaultSessionFactory;
    return factory({ config, client: config.getGeminiClient(), streamId });
  }

  private async prepareConfig(
    config: GeminiCoreConfigLike,
    request: Partial<ProviderRequest>
  ): Promise<void> {
    await this.prepareAuth(config, request);
    await config.initialize();
  }

  private async prepareAuth(
    config: GeminiCoreConfigLike,
    request: Partial<ProviderRequest>
  ): Promise<void> {
    const authType =
      (request.options?.geminiAuthType as AuthType | undefined) ??
      (process.env.AGENT_BRIDGE_GEMINI_AUTH_TYPE as AuthType | undefined) ??
      AuthType.LOGIN_WITH_GOOGLE;
    const apiKey = request.options?.geminiApiKey as string | undefined;
    const baseUrl = request.options?.geminiBaseUrl as string | undefined;
    const customHeaders = request.options?.geminiCustomHeaders as
      | Record<string, string>
      | undefined;

    await config.refreshAuth?.(authType, apiKey, baseUrl, customHeaders);
  }

  private async resumeSession(
    config: GeminiCoreConfigLike,
    sessionId: string | undefined,
    resumed: ResumedSessionData | null
  ): Promise<void> {
    if (!sessionId) {
      return;
    }

    if (!resumed) {
      debugGeminiResume(`no session history found for ${sessionId}`);
      return;
    }

    const history = convertSessionToClientHistory(resumed.conversation.messages);
    debugGeminiResume(
      `resuming ${sessionId} from ${resumed.filePath || "<config.loadSession>"} ` +
        `messages=${resumed.conversation.messages.length} history=${history.length}`
    );
    await config
      .getGeminiClient()
      .resumeChat?.(history, resumed);
  }

  private async loadSession(
    config: GeminiCoreConfigLike,
    sessionId: string
  ): Promise<ResumedSessionData | null> {
    if (config.loadSession) {
      const conversation = await config.loadSession(sessionId);
      if (conversation && conversation.messages.length > 0) {
        return { conversation, filePath: "" };
      }
    }

    const files = await config.storage?.listProjectChatFiles?.();
    if (!files) {
      return null;
    }

    for (const file of files) {
      const filePath =
        isAbsolute(file.filePath) || !config.storage?.getProjectTempDir
          ? file.filePath
          : join(config.storage.getProjectTempDir(), file.filePath);
      const conversation = await loadConversationRecord(filePath);
      if (conversation?.sessionId === sessionId && conversation.messages.length > 0) {
        return { conversation, filePath };
      }
    }

    return null;
  }

}

function defaultConfigFactory(
  request: ProviderRequest,
  rid: string
): GeminiCoreConfigLike {
  const params = createGeminiConfigParameters(request, rid);

  return new Config(params);
}

export function createGeminiConfigParameters(
  request: ProviderRequest,
  rid: string
): ConfigParameters {
  const cwd = request.cwd ?? process.cwd();
  const requestedConfig =
    (request.options?.geminiConfig as Partial<ConfigParameters> | undefined) ??
    {};
  const {
    sessionId: _ignoredSessionId,
    cwd: _ignoredCwd,
    targetDir: _ignoredTargetDir,
    includeDirectories: _ignoredIncludeDirectories,
    ...configOverrides
  } = requestedConfig;
  const params: ConfigParameters = {
    clientName: "agent-bridge",
    debugMode: false,
    model: request.model ?? DEFAULT_GEMINI_FLASH_MODEL,
    interactive: false,
    approvalMode: "yolo" as ConfigParameters["approvalMode"],
    noBrowser: true,
    trustedFolder: true,
    disableYoloMode: false,
    checkpointing: true,
    skillsSupport: true,
    mcpEnabled: true,
    extensionsEnabled: true,
    ...configOverrides,
    sessionId: request.session ?? createSessionId(),
    targetDir: cwd,
    cwd
  };

  if (rid === "detect") {
    params.sessionId = `agent_bridge_detect_${createSessionId()}`;
    params.checkpointing = false;
    params.skillsSupport = false;
    params.mcpEnabled = false;
    params.extensionsEnabled = false;
  }

  return params;
}

function defaultSessionFactory(deps: {
  config: GeminiCoreConfigLike;
  client: ReturnType<GeminiCoreConfigLike["getGeminiClient"]>;
  streamId?: string;
}): GeminiCoreSessionLike {
  return new LegacyAgentSession({
    config: deps.config as Config,
    client: deps.client as GeminiClient,
    streamId: deps.streamId
  });
}

function contentText(
  content: Array<{ type: string; text?: string; thought?: string }>
): string {
  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text ?? "";
      }
      if (part.type === "thought") {
        return part.thought ?? "";
      }
      return "";
    })
    .join("");
}

function debugGeminiResume(message: string): void {
  if (process.env.AGENT_BRIDGE_DEBUG_GEMINI_RESUME === "1") {
    console.error(`[gemini resume] ${message}`);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
