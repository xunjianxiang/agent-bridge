import { Controller, Get, Param } from "@nestjs/common";
import type { ProviderInfo } from "../core/types.js";
import { ProviderRegistry } from "./provider.registry.js";

@Controller("providers")
export class ProvidersController {
  constructor(private readonly registry: ProviderRegistry) {}

  @Get()
  async list(): Promise<{ providers: ProviderInfo[] }> {
    return { providers: await this.registry.detectAll() };
  }

  @Get(":provider")
  async get(@Param("provider") provider: string): Promise<ProviderInfo> {
    const providers = await this.registry.detectAll();
    const info = providers.find((item) => item.id === provider);
    if (info) {
      return info;
    }
    return await this.registry.get(provider as never).detect();
  }
}
