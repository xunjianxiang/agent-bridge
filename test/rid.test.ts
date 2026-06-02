import { describe, expect, it } from "vitest";
import { createRid } from "../src/core/rid.js";

describe("createRid", () => {
  it("returns an unprefixed UUIDv7", () => {
    const rid = createRid(1_700_000_000_000);

    expect(rid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(rid.startsWith("inv_")).toBe(false);
  });

  it("sorts lexicographically by timestamp", () => {
    const earlier = createRid(1_700_000_000_000);
    const later = createRid(1_700_000_000_001);

    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it("sorts lexicographically by generation order within the same millisecond", () => {
    const ids = Array.from({ length: 32 }, () => createRid(1_700_000_000_002));

    expect([...ids].sort()).toEqual(ids);
  });
});
