import { describe, expect, it } from "vitest";
import {
  createCodexEventNormalizer,
  normalizeCodexEvent
} from "../src/providers/codex-normalizer.js";

describe("normalizeCodexEvent", () => {
  it("maps Codex agent_message items to message events", () => {
    const events = normalizeCodexEvent("inv_1", {
      type: "item.completed",
      item: {
        id: "item_1",
        type: "agent_message",
        text: "hello"
      }
    });

    expect(events).toMatchObject([
      {
        type: "message",
        requestId: "inv_1",
        role: "assistant",
        content: "hello"
      }
    ]);
  });

  it("maps Codex MCP tool calls to tool_result events when completed", () => {
    const events = normalizeCodexEvent("inv_1", {
      type: "item.completed",
      item: {
        id: "tool_1",
        type: "mcp_tool_call",
        server: "fs",
        tool: "read_file",
        arguments: { path: "README.md" },
        result: { content: [], structured_content: { ok: true } },
        status: "completed"
      }
    });

    expect(events).toMatchObject([
      {
        type: "tool_result",
        requestId: "inv_1",
        toolCallId: "tool_1",
        status: "success"
      }
    ]);
  });

  it("maps Codex turn completion to done events", () => {
    const events = normalizeCodexEvent("inv_1", {
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0
      }
    });

    expect(events).toMatchObject([
      {
        type: "done",
        requestId: "inv_1",
        response: {
          requestId: "inv_1",
          provider: "codex"
        }
      }
    ]);
  });

  it("carries the Codex thread id into the final done response", () => {
    const normalize = createCodexEventNormalizer("inv_1");

    normalize({
      type: "thread.started",
      thread_id: "thread_123"
    });
    const events = normalize({
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0
      }
    });

    expect(events).toMatchObject([
      {
        type: "done",
        response: {
          session: "thread_123"
        }
      }
    ]);
  });
});
