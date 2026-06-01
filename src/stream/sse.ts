import type { StreamEvent } from "../core/types.js";

export function formatSseEvent(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
