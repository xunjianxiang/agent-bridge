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

  @Get("invoke/:rid")
  async getRun(@Param("rid") rid: string): Promise<InvokeRunSnapshot> {
    return await this.invokeService.getRun(rid);
  }

  @Post("cancel")
  async cancel(
    @Body() body: { rid?: string }
  ): Promise<{ rid: string; cancelled: true }> {
    if (!body.rid) {
      throw new BadRequestException("rid is required");
    }
    return await this.invokeService.cancel(body.rid);
  }
}
