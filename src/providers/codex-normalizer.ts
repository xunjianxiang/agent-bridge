import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";
import type { StreamEvent } from "../core/types.js";

export function createCodexEventNormalizer(
  rid: string,
  initialSession?: string
): (event: ThreadEvent) => StreamEvent[] {
  let session = initialSession;

  return (event: ThreadEvent): StreamEvent[] => {
    if (event.type === "thread.started") {
      session = event.thread_id;
    }

    return normalizeCodexEvent(rid, event).map((streamEvent) => {
      if (streamEvent.type !== "done") {
        return streamEvent;
      }

      return {
        ...streamEvent,
        response: {
          ...streamEvent.response,
          session: streamEvent.response.session ?? session
        }
      };
    });
  };
}

export function normalizeCodexEvent(
  rid: string,
  event: ThreadEvent
): StreamEvent[] {
  const timestamp = new Date().toISOString();

  switch (event.type) {
    case "thread.started":
      return [
        {
          type: "message",
          rid,
          role: "system",
          content: `Codex thread started: ${event.thread_id}`,
          timestamp,
          raw: event
        }
      ];
    case "turn.completed":
      return [
        {
          type: "done",
          rid,
          response: {
            rid,
            provider: "codex",
            usage: codexUsageToRecord(event.usage),
            raw: event
          },
          timestamp
        }
      ];
    case "turn.failed":
      return [
        {
          type: "error",
          rid,
          error: {
            code: "PROVIDER_TURN_FAILED",
            message: event.error.message,
            provider: "codex"
          },
          timestamp,
          raw: event
        }
      ];
    case "error":
      return [
        {
          type: "error",
          rid,
          error: {
            code: "PROVIDER_ERROR",
            message: event.message,
            provider: "codex"
          },
          timestamp,
          raw: event
        }
      ];
    case "item.started":
    case "item.updated":
    case "item.completed":
      return normalizeCodexItem(rid, event.item, event.type, timestamp, event);
    case "turn.started":
      return [];
  }
}

function normalizeCodexItem(
  rid: string,
  item: ThreadItem,
  phase: "item.started" | "item.updated" | "item.completed",
  timestamp: string,
  raw: ThreadEvent
): StreamEvent[] {
  switch (item.type) {
    case "agent_message":
      return [
        {
          type: "message",
          rid,
          role: "assistant",
          content: item.text,
          timestamp,
          raw
        }
      ];
    case "reasoning":
      return [
        {
          type: "message",
          rid,
          role: "system",
          content: item.text,
          timestamp,
          raw
        }
      ];
    case "command_execution":
      return normalizeCommandExecution(rid, item, phase, timestamp, raw);
    case "mcp_tool_call":
      return normalizeMcpToolCall(rid, item, phase, timestamp, raw);
    case "error":
      return [
        {
          type: "error",
          rid,
          error: {
            code: "PROVIDER_ITEM_ERROR",
            message: item.message,
            provider: "codex"
          },
          timestamp,
          raw
        }
      ];
    case "file_change":
    case "todo_list":
    case "web_search":
      return [
        {
          type: "tool_call",
          rid,
          toolCallId: item.id,
          name: item.type,
          status: mapCodexPhase(phase),
          timestamp,
          raw
        }
      ];
  }
}

function normalizeCommandExecution(
  rid: string,
  item: Extract<ThreadItem, { type: "command_execution" }>,
  phase: "item.started" | "item.updated" | "item.completed",
  timestamp: string,
  raw: ThreadEvent
): StreamEvent[] {
  const events: StreamEvent[] = [
    {
      type: "tool_call",
      rid,
      toolCallId: item.id,
      name: "command_execution",
      args: { command: item.command },
      status: mapCodexPhase(phase, item.status),
      timestamp,
      raw
    }
  ];

  if (item.aggregated_output) {
    events.push({
      type: "stdout",
      rid,
      data: item.aggregated_output,
      timestamp,
      raw
    });
  }

  if (phase === "item.completed") {
    events.push({
      type: "tool_result",
      rid,
      toolCallId: item.id,
      status: item.status === "failed" ? "error" : "success",
      output: {
        exitCode: item.exit_code,
        aggregatedOutput: item.aggregated_output
      },
      timestamp,
      raw
    });
  }

  return events;
}

function normalizeMcpToolCall(
  rid: string,
  item: Extract<ThreadItem, { type: "mcp_tool_call" }>,
  phase: "item.started" | "item.updated" | "item.completed",
  timestamp: string,
  raw: ThreadEvent
): StreamEvent[] {
  if (phase === "item.completed") {
    return [
      {
        type: "tool_result",
        rid,
        toolCallId: item.id,
        status: item.status === "failed" ? "error" : "success",
        output: item.result,
        error: item.error
          ? {
              code: "MCP_TOOL_ERROR",
              message: item.error.message,
              provider: "codex"
            }
          : undefined,
        timestamp,
        raw
      }
    ];
  }

  return [
    {
      type: "tool_call",
      rid,
      toolCallId: item.id,
      name: `${item.server}.${item.tool}`,
      args: item.arguments as Record<string, unknown>,
      status: mapCodexPhase(phase, item.status),
      timestamp,
      raw
    }
  ];
}

function mapCodexPhase(
  phase: "item.started" | "item.updated" | "item.completed",
  status?: string
): "started" | "running" | "completed" | "failed" {
  if (status === "failed") {
    return "failed";
  }
  if (phase === "item.started") {
    return "started";
  }
  if (phase === "item.completed") {
    return "completed";
  }
  return "running";
}

function codexUsageToRecord(usage: Usage): Record<string, unknown> {
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens
  };
}
