import type {
  AgentProvider,
  BridgeError,
  ProviderCapabilities,
  ProviderId,
  ProviderInfo,
  ProviderRequest,
  ProviderResponse,
  StreamEvent
} from "../core/types.js";

export abstract class BaseProvider implements AgentProvider {
  abstract readonly id: ProviderId;

  abstract capabilities(): ProviderCapabilities;

  abstract detect(): Promise<ProviderInfo>;

  async invoke(
    requestId: string,
    request: ProviderRequest
  ): Promise<ProviderResponse> {
    let finalText = "";
    let response: ProviderResponse | undefined;
    let lastError: BridgeError | undefined;

    for await (const event of this.stream(requestId, request)) {
      if (event.type === "message" && event.role === "assistant") {
        finalText += event.delta ?? event.content ?? "";
      }
      if (event.type === "done") {
        response = event.response;
        break;
      }
      if (event.type === "error") {
        lastError = event.error;
      }
    }

    if (!response && lastError) {
      throw new Error(lastError.message);
    }

    return (
      response
        ? {
            ...response,
            session: response.session ?? request.session,
            finalText: response.finalText ?? finalText
          }
        : {
        requestId,
        provider: this.id,
        session: request.session,
        finalText
      }
    );
  }

  abstract stream(
    requestId: string,
    request: ProviderRequest
  ): AsyncIterable<StreamEvent>;

  async cancel(_requestId: string): Promise<void> {
    return;
  }

  protected info(
    status: ProviderInfo["status"],
    overrides: Partial<ProviderInfo> = {}
  ): ProviderInfo {
    return {
      ...this.capabilities(),
      status,
      authStatus: "unknown",
      diagnostics: [],
      lastCheckedAt: new Date().toISOString(),
      ...overrides
    };
  }
}
