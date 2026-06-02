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
  requestId: string
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
        await this.prepareConfig(config, {});
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
          message: "Gemini CLI Core adapter currently accepts string input only.",
          provider: this.id
        }
      };
      return;
    }

    let sessionId = request.session;
    let session: GeminiCoreSessionLike | undefined;

    try {
      const config = this.createConfig(request, requestId);
      await this.prepareAuth(config, request);
      await config.storage?.initialize?.();
      const resumed = request.session ? await this.loadSession(config, request.session) : null;
      await config.initialize();
      await this.resumeSession(config, request.session, resumed);

      sessionId = request.session ?? config.getSessionId();
      session = this.createSession(config, sessionId);
      this.sessions.set(requestId, session);

      for await (const event of session.sendStream({
        message: {
          content: [{ type: "text", text: request.input }]
        }
      })) {
        const normalized = this.normalizeAgentEvent(requestId, event, sessionId);
        if (event.type === "initialize") {
          sessionId = event.sessionId;
        }
        for (const item of normalized) {
          yield item;
        }
      }
    } catch (error) {
      yield {
        type: "error",
        requestId,
        timestamp: new Date().toISOString(),
        error: {
          code: "PROVIDER_ERROR",
          message: error instanceof Error ? error.message : String(error),
          provider: this.id
        }
      };
    } finally {
      this.sessions.delete(requestId);
    }
  }

  override async cancel(requestId: string): Promise<void> {
    const session = this.sessions.get(requestId);
    if (session) {
      await session.abort();
      this.sessions.delete(requestId);
    }
  }

  private createConfig(
    request: ProviderRequest,
    requestId: string
  ): GeminiCoreConfigLike {
    const factory = this.deps[GEMINI_CORE_CONFIG_FACTORY] ?? defaultConfigFactory;
    return factory(request, requestId);
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
      (request.nativeOptions?.geminiAuthType as AuthType | undefined) ??
      (process.env.AGENT_BRIDGE_GEMINI_AUTH_TYPE as AuthType | undefined) ??
      AuthType.LOGIN_WITH_GOOGLE;
    const apiKey = request.nativeOptions?.geminiApiKey as string | undefined;
    const baseUrl = request.nativeOptions?.geminiBaseUrl as string | undefined;
    const customHeaders = request.nativeOptions?.geminiCustomHeaders as
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

  private normalizeAgentEvent(
    requestId: string,
    event: AgentEvent,
    sessionId: string | undefined
  ): StreamEvent[] {
    const timestamp = event.timestamp || new Date().toISOString();

    switch (event.type) {
      case "initialize":
        return [
          {
            type: "message",
            requestId,
            role: "system",
            content: `Gemini core session initialized${
              event.agentId ? ` with ${event.agentId}` : ""
            }.`,
            timestamp,
            raw: event
          }
        ];
      case "session_update":
        return [
          {
            type: "message",
            requestId,
            role: "system",
            content: event.model
              ? `Gemini model set to ${event.model}.`
              : "Gemini session updated.",
            timestamp,
            raw: event
          }
        ];
      case "message":
        return [
          {
            type: "message",
            requestId,
            role: mapAgentRole(event.role),
            delta: contentText(event.content),
            timestamp,
            raw: event
          }
        ];
      case "tool_request":
        return [
          {
            type: "tool_call",
            requestId,
            toolCallId: event.requestId,
            name: event.name,
            args: event.args,
            status: "started",
            timestamp,
            raw: event
          }
        ];
      case "tool_update":
        return [
          {
            type: "tool_call",
            requestId,
            toolCallId: event.requestId,
            name: event.display?.name ?? "tool",
            status: "running",
            timestamp,
            raw: event
          }
        ];
      case "tool_response":
        return [
          {
            type: "tool_result",
            requestId,
            toolCallId: event.requestId,
            status: event.isError ? "error" : "success",
            output: event.data ?? contentText(event.content ?? []),
            timestamp,
            raw: event
          }
        ];
      case "usage":
        return [
          {
            type: "stdout",
            requestId,
            data: JSON.stringify(event),
            timestamp,
            raw: event
          }
        ];
      case "agent_end":
        return [
          {
            type: "done",
            requestId,
            response: {
              requestId,
              provider: this.id,
              session: sessionId,
              usage: event.data,
              raw: event
            },
            timestamp
          }
        ];
      case "error":
        return [
          {
            type: "error",
            requestId,
            error: {
              code: event.status,
              message: event.message,
              provider: this.id,
              details: event
            },
            timestamp,
            raw: event
          }
        ];
      case "agent_start":
      case "elicitation_request":
      case "elicitation_response":
      case "custom":
        return [
          {
            type: "stdout",
            requestId,
            data: JSON.stringify(event),
            timestamp,
            raw: event
          }
        ];
    }
  }
}

function defaultConfigFactory(
  request: ProviderRequest,
  requestId: string
): GeminiCoreConfigLike {
  const cwd = request.cwd ?? process.cwd();
  const params: ConfigParameters = {
    sessionId: request.session ?? createSessionId(),
    clientName: "agent-bridge",
    targetDir: cwd,
    cwd,
    debugMode: false,
    model: request.model ?? DEFAULT_GEMINI_FLASH_MODEL,
    interactive: false,
    noBrowser: true,
    trustedFolder: true,
    checkpointing: true,
    skillsSupport: true,
    mcpEnabled: true,
    extensionsEnabled: true,
    ...(request.nativeOptions?.geminiConfig as Partial<ConfigParameters> | undefined)
  };

  if (requestId === "detect") {
    params.sessionId = `agent_bridge_detect_${createSessionId()}`;
    params.checkpointing = false;
    params.skillsSupport = false;
    params.mcpEnabled = false;
    params.extensionsEnabled = false;
  }

  return new Config(params);
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

function mapAgentRole(role: "user" | "agent" | "developer"): "assistant" | "user" | "system" {
  if (role === "agent") {
    return "assistant";
  }
  if (role === "developer") {
    return "system";
  }
  return "user";
}

function debugGeminiResume(message: string): void {
  if (process.env.AGENT_BRIDGE_DEBUG_GEMINI_RESUME === "1") {
    console.error(`[gemini resume] ${message}`);
  }
}
