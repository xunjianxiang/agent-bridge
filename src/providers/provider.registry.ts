import { Injectable, NotFoundException } from "@nestjs/common";
import type { AgentProvider, ProviderId, ProviderInfo } from "../core/types.js";
import { ClaudeProvider } from "./claude.provider.js";
import { CodexProvider } from "./codex.provider.js";
import { GeminiProvider } from "./gemini.provider.js";

@Injectable()
export class ProviderRegistry {
  private readonly providers: Map<ProviderId, AgentProvider>;
  private detectionCache?: ProviderInfo[];
  private detectionCacheUpdatedAt = 0;
  private detectionRefresh?: Promise<ProviderInfo[]>;

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
    if (!this.detectionCache) {
      return await this.refreshDetection();
    }

    if (!this.isDetectionCacheExpired()) {
      return this.detectionCache;
    }

    void this.refreshDetection();
    return this.detectionCache;
  }

  private async refreshDetection(): Promise<ProviderInfo[]> {
    if (this.detectionRefresh) {
      return await this.detectionRefresh;
    }

    this.detectionRefresh = Promise.all(
      this.all().map((provider) => provider.detect())
    ).then((providers) => {
      this.detectionCache = providers;
      this.detectionCacheUpdatedAt = Date.now();
      return providers;
    });

    try {
      return await this.detectionRefresh;
    } finally {
      this.detectionRefresh = undefined;
    }
  }

  private isDetectionCacheExpired(): boolean {
    return Date.now() - this.detectionCacheUpdatedAt >= providerDetectionTtlMs();
  }
}

function providerDetectionTtlMs(): number {
  const raw = Number(process.env.PROVIDER_DETECTION_TTL_MS ?? "30000");
  return Number.isFinite(raw) && raw >= 0 ? raw : 30000;
}
