import { Module } from "@nestjs/common";
import { ProcessModule } from "../process/process.module.js";
import { ClaudeProvider } from "./claude.provider.js";
import { CodexProvider } from "./codex.provider.js";
import { GeminiProvider } from "./gemini.provider.js";
import { ProviderRegistry } from "./provider.registry.js";
import { ProvidersController } from "./providers.controller.js";

@Module({
  imports: [ProcessModule],
  controllers: [ProvidersController],
  providers: [CodexProvider, ClaudeProvider, GeminiProvider, ProviderRegistry],
  exports: [ProviderRegistry]
})
export class ProvidersModule {}
