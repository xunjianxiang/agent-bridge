import { Injectable, NotFoundException } from "@nestjs/common";
import type { AgentProvider, ProviderId, ProviderInfo } from "../core/types.js";
import { ClaudeProvider } from "./claude.provider.js";
import { CodexProvider } from "./codex.provider.js";
import { GeminiProvider } from "./gemini.provider.js";

@Injectable()
export class ProviderRegistry {
  private readonly providers: Map<ProviderId, AgentProvider>;

  constructor(
    codex: CodexProvider,
    claude: ClaudeProvider,
    gemini: GeminiProvider
  ) {
    const entries: Array<[ProviderId, AgentProvider]> = [
      [codex.id, codex],
      [claude.id, claude],
      [gemini.id, gemini]
    ];
    this.providers = new Map(entries);
  }

  get(id: ProviderId): AgentProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new NotFoundException(`Unknown provider: ${id}`);
    }
    return provider;
  }

  all(): AgentProvider[] {
    return Array.from(this.providers.values());
  }

  async detectAll(): Promise<ProviderInfo[]> {
    return await Promise.all(this.all().map((provider) => provider.detect()));
  }
}
