import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import type { ProviderResponse } from "../core/types.js";
import { InvokeService } from "./invoke.service.js";

@Controller()
export class InvokeController {
  constructor(private readonly invokeService: InvokeService) {}

  @Post("invoke")
  async invoke(@Body() body: unknown): Promise<ProviderResponse> {
    return await this.invokeService.invoke(body);
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
