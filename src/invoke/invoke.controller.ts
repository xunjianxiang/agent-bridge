import { BadRequestException, Body, Controller, Get, Param, Post } from "@nestjs/common";
import type { ProviderResponse } from "../core/types.js";
import { InvokeService, type InvokeRunSnapshot } from "./invoke.service.js";

@Controller()
export class InvokeController {
  constructor(private readonly invokeService: InvokeService) {}

  @Post("invoke")
  async invoke(@Body() body: unknown): Promise<ProviderResponse> {
    return await this.invokeService.invoke(body);
  }

  @Post("invoke/async")
  start(@Body() body: unknown): InvokeRunSnapshot {
    return this.invokeService.start(body);
  }

  @Get("invoke/:requestId")
  async getRun(@Param("requestId") requestId: string): Promise<InvokeRunSnapshot> {
    return await this.invokeService.getRun(requestId);
  }

  @Post("cancel")
  async cancel(
    @Body() body: { requestId?: string }
  ): Promise<{ requestId: string; cancelled: true }> {
    if (!body.requestId) {
      throw new BadRequestException("requestId is required");
    }
    return await this.invokeService.cancel(body.requestId);
  }
}
