import { Controller, Get } from "@nestjs/common";
import type { ProviderInfo } from "../core/types.js";
import { ProviderRegistry } from "./provider.registry.js";

@Controller("providers")
export class ProvidersController {
  constructor(private readonly registry: ProviderRegistry) {}

  @Get()
  async list(): Promise<{ providers: ProviderInfo[] }> {
    return { providers: await this.registry.detectAll() };
  }
}
