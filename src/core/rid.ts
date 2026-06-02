import { randomBytes } from "node:crypto";

let lastTimestamp = 0;
let sequence = 0;

export function createRid(timestampMs = Date.now()): string {
  const bytes = randomBytes(16);
  let timestamp = Math.trunc(timestampMs);

  if (timestamp <= lastTimestamp) {
    timestamp = lastTimestamp;
    sequence = (sequence + 1) & 0xfff;
    if (sequence === 0) {
      timestamp += 1;
    }
  } else {
    sequence = 0;
  }
  lastTimestamp = timestamp;

  bytes[0] = (timestamp / 0x10000000000) & 0xff;
  bytes[1] = (timestamp / 0x100000000) & 0xff;
  bytes[2] = (timestamp / 0x1000000) & 0xff;
  bytes[3] = (timestamp / 0x10000) & 0xff;
  bytes[4] = (timestamp / 0x100) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}
