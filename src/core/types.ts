export type ProviderId = "codex" | "claude" | "gemini";

export type ProviderStatus =
  | "available"
  | "missing"
  | "misconfigured"
  | "not_implemented"
  | "error";

export interface BridgeError {
  code: string;
  message: string;
  provider?: ProviderId;
  retryable?: boolean;
  details?: unknown;
}

export interface ProviderCapabilities {
  id: ProviderId;
  displayName: string;
  streaming: boolean;
  cancel: "abort-signal" | "interrupt" | "process-kill";
  nativeSession: boolean;
  tools: {
    builtin: boolean;
    mcp: boolean;
    hostProvided: boolean;
  };
  input: {
    text: boolean;
    localImage: boolean;
    asyncMessages: boolean;
  };
}

export interface ProviderInfo extends ProviderCapabilities {
  status: ProviderStatus;
  executable?: string;
  version?: string;
  sdkVersion?: string;
  authStatus: "unknown" | "configured" | "missing";
  diagnostics: string[];
  lastCheckedAt: string;
}

export interface ProviderRequest {
  provider: ProviderId;
  input:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "local_image"; path: string }
      >;
  cwd?: string;
  model?: string;
  session?: string;
  nativeOptions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  requestId: string;
  provider: ProviderId;
  session?: string;
  finalText?: string;
  usage?: Record<string, unknown>;
  raw?: unknown;
}

export type StreamEvent =
  | {
      type: "stdout";
      requestId: string;
      data: string;
      timestamp: string;
      raw?: unknown;
    }
  | {
      type: "stderr";
      requestId: string;
      data: string;
      timestamp: string;
      raw?: unknown;
    }
  | {
      type: "message";
      requestId: string;
      role: "assistant" | "user" | "system";
      delta?: string;
      content?: string;
      raw?: unknown;
      timestamp: string;
    }
  | ToolCallEvent
  | {
      type: "tool_result";
      requestId: string;
      toolCallId: string;
      status: "success" | "error" | "cancelled";
      output?: unknown;
      error?: BridgeError;
      raw?: unknown;
      timestamp: string;
    }
  | {
      type: "done";
      requestId: string;
      response: ProviderResponse;
      timestamp: string;
    }
  | {
      type: "error";
      requestId: string;
      error: BridgeError;
      raw?: unknown;
      timestamp: string;
    };

export interface ToolCallEvent {
  type: "tool_call";
  requestId: string;
  toolCallId: string;
  name: string;
  args?: Record<string, unknown>;
  status?: "started" | "running" | "awaiting_approval" | "completed" | "failed";
  raw?: unknown;
  timestamp: string;
}

export interface AgentProvider {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  detect(): Promise<ProviderInfo>;
  invoke(requestId: string, request: ProviderRequest): Promise<ProviderResponse>;
  stream(requestId: string, request: ProviderRequest): AsyncIterable<StreamEvent>;
  cancel(requestId: string): Promise<void>;
}
