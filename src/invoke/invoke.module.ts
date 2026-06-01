import { Module } from "@nestjs/common";
import { ProvidersModule } from "../providers/providers.module.js";
import { InvocationRegistryService } from "./invocation-registry.service.js";
import { InvokeController } from "./invoke.controller.js";
import { InvokeService } from "./invoke.service.js";

@Module({
  imports: [ProvidersModule],
  controllers: [InvokeController],
  providers: [InvokeService, InvocationRegistryService],
  exports: [InvokeService, InvocationRegistryService]
})
export class InvokeModule {}
