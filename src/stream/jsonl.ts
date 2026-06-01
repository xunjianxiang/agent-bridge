import type { Readable } from "node:stream";

export async function* parseJsonLines(
  stream: Readable
): AsyncIterable<{ value?: unknown; raw: string; error?: Error }> {
  let buffer = "";

  for await (const chunk of stream) {
    buffer += Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk);

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        yield parseLine(line);
      }

      newlineIndex = buffer.indexOf("\n");
    }
  }

  const tail = buffer.trim();
  if (tail.length > 0) {
    yield parseLine(tail);
  }
}

function parseLine(line: string): { value?: unknown; raw: string; error?: Error } {
  try {
    return { value: JSON.parse(line) as unknown, raw: line };
  } catch (error) {
    return {
      raw: line,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
