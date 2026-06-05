import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthController } from "./health/health.controller.js";
import { InvokeModule } from "./invoke/invoke.module.js";
import { ProvidersModule } from "./providers/providers.module.js";
import { RunsModule } from "./runs/runs.module.js";
import { StreamModule } from "./stream/stream.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ProvidersModule,
    InvokeModule,
    RunsModule,
    StreamModule
  ],
  controllers: [HealthController]
})
export class AppModule {}
