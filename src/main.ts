import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication
} from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { configureCors } from "./core/cors.js";
import { BridgeHttpExceptionFilter } from "./core/http-error.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true })
  );

  const config = app.get(ConfigService);
  configureCors(app, config);
  app.useGlobalFilters(new BridgeHttpExceptionFilter());
  const host = config.get<string>("HOST", "127.0.0.1");
  const port = Number(config.get<string>("PORT", "8787"));

  await app.listen(port, host);
  Logger.log(`AgentBridge Gateway listening on http://${host}:${port}`);
}

void bootstrap();
