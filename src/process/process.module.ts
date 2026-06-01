import { Module } from "@nestjs/common";
import { ProcessRunnerService } from "./process-runner.service.js";

@Module({
  providers: [ProcessRunnerService],
  exports: [ProcessRunnerService]
})
export class ProcessModule {}
