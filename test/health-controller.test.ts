import { describe, expect, it } from "vitest";
import { HealthController } from "../src/health/health.controller.js";

describe("HealthController", () => {
  it("returns service metadata for liveness", () => {
    const controller = new HealthController();

    expect(controller.health()).toMatchObject({
      status: "ok",
      name: "agent-bridge",
      version: "0.1.0"
    });
    expect(controller.health().uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("returns readiness metadata", () => {
    const controller = new HealthController();

    expect(controller.ready()).toMatchObject({
      status: "ready",
      providers: "lazy"
    });
  });
});
