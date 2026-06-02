import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { configureCors } from "../src/core/cors.js";

describe("configureCors", () => {
  it("does not enable browser CORS by default", () => {
    const app = { enableCors: vi.fn() };

    configureCors(app, new ConfigService({}));

    expect(app.enableCors).not.toHaveBeenCalled();
  });

  it("enables CORS only for configured origins", () => {
    const app = { enableCors: vi.fn() };

    configureCors(
      app,
      new ConfigService({
        CORS_ORIGINS: "http://localhost:3000,https://example.com"
      })
    );

    expect(app.enableCors).toHaveBeenCalledWith({
      origin: ["http://localhost:3000", "https://example.com"]
    });
  });
});
