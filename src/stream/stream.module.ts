import { Module } from "@nestjs/common";
import { InvokeModule } from "../invoke/invoke.module.js";
import { ProvidersModule } from "../providers/providers.module.js";
import { StreamController } from "./stream.controller.js";

@Module({
  imports: [ProvidersModule, InvokeModule],
  controllers: [StreamController]
})
export class StreamModule {}
