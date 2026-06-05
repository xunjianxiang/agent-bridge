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
  options?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  rid: string;
  provider: ProviderId;
  session?: string;
  output?: string;
  usage?: Record<string, unknown>;
  raw?: unknown;
}

export type StreamEvent = ProviderStreamEvent;

export type ProviderStreamEvent =
  | {
      type: "event";
      rid: string;
      provider: ProviderId;
      event: unknown;
      timestamp: string;
    }
  | {
      type: "done";
      rid: string;
      provider: ProviderId;
      response: ProviderResponse;
      event?: unknown;
      timestamp: string;
    }
  | {
      type: "error";
      rid: string;
      provider: ProviderId;
      error: BridgeError;
      event?: unknown;
      timestamp: string;
    };

export interface AgentProvider {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  detect(): Promise<ProviderInfo>;
  invoke(rid: string, request: ProviderRequest): Promise<ProviderResponse>;
  stream(rid: string, request: ProviderRequest): AsyncIterable<StreamEvent>;
  cancel(rid: string): Promise<void>;
}
