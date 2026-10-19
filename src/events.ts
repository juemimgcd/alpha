import type { BaseMessage } from "@langchain/core/messages";
import type { ToolStatus } from "./hooks.ts";

export type RunResult =
  | { status: "completed"; answer: string; turns: number }
  | { status: "stopped"; reason: string; turns: number };

export type AgentEndEvent = {
  type: "agent_end";
  status: "completed" | "stopped" | "aborted" | "error";
  detail: string;
};

export type AgentEvent =
  | { type: "message_end"; message: BaseMessage }
  | { type: "tool_start"; callId: string; name: string }
  | {
      type: "tool_end";
      callId: string;
      name: string;
      status: ToolStatus;
      raw: string;
      content: string;
    }
  | { type: "turn_end"; turn: number; toolCount: number; hasAnswer: boolean }
  | AgentEndEvent;

export type EventListener = (event: AgentEvent) => void | Promise<void>;
export type EmitEvent = (event: AgentEvent) => Promise<void>;








