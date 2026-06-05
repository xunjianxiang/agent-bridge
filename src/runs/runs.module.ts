import { Module } from "@nestjs/common";
import { ProvidersModule } from "../providers/providers.module.js";
import { RunsController } from "./runs.controller.js";
import { RunsService } from "./runs.service.js";

@Module({
  imports: [ProvidersModule],
  controllers: [RunsController],
  providers: [RunsService],
  exports: [RunsService]
})
export class RunsModule {}
