import { Controller, Get } from "@nestjs/common";

@Controller()
export class HealthController {
  @Get("health")
  health(): {
    status: "ok";
    name: string;
    version: string;
    uptimeSeconds: number;
  } {
    return {
      status: "ok",
      name: "agent-bridge",
      version: "0.1.0",
      uptimeSeconds: Math.floor(process.uptime())
    };
  }

  @Get("ready")
  ready(): { status: "ready"; providers: "lazy" } {
    return { status: "ready", providers: "lazy" };
  }
}
