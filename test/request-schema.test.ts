import { describe, expect, it } from "vitest";
import { providerRequestSchema } from "../src/core/request.schema.js";

describe("providerRequestSchema", () => {
  it("accepts session as the external resume field", () => {
    const result = providerRequestSchema.parse({
      provider: "codex",
      input: "continue",
      session: "thread_123"
    });

    expect(result.session).toBe("thread_123");
  });
});
