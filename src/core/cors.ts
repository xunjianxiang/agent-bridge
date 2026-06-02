import type { ConfigService } from "@nestjs/config";

interface CorsApp {
  enableCors(options?: unknown): unknown;
}

export function configureCors(app: CorsApp, config: ConfigService): void {
  const origins = config
    .get<string>("CORS_ORIGINS", "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    return;
  }

  app.enableCors({ origin: origins });
}
