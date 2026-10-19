import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { executeTool } from "./dispatch.ts";
import type { EmitEvent, RunResult } from "./events.ts";
import { copyMessages } from "./hooks.ts";
import type { Hook, TurnInfo } from "./hooks.ts";
import type { ModelIO } from "./model-io.ts";
import { responseCalls, validateHistory } from "./protocol.ts";
import type { Tool } from "./tools.ts";


export async function runLoop(
  messages: BaseMessage[],
  model: ModelIO,
  tools: readonly Tool[],
  hooks: readonly Hook[],
  cwd: string,
  maxTurns: number,
  signal: AbortSignal,
  emit: EmitEvent,
): Promise<RunResult> {
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    signal.throwIfAborted();
    let requestMessages = copyMessages(messages);

    for (const hook of hooks) {
      const replacement = await hook.beforeModel?.(requestMessages, signal);
      if (replacement !== undefined) {
        requestMessages = replacement;
      }
    }
    signal.throwIfAborted();
    validateHistory(requestMessages);

    const response = await model.request(requestMessages, signal);
    signal.throwIfAborted();
    const calls = responseCalls(response);

    for (const hook of hooks) {
      if (hook.afterModel !== undefined) {
        const snapshot = copyMessages([response])[0];
        if (!(snapshot instanceof AIMessage)) {
          throw new Error("模型消息副本没有恢复为 AIMessage");
        }
        await hook.afterModel(snapshot, signal);
      }
    }
    signal.throwIfAborted();
    await emit({ type: "message_end", message: response });

    for (const call of calls) {
      await emit({ type: "tool_start", callId: call.id, name: call.name });
      const execution = await executeTool(call, tools, hooks, cwd, signal);
      await emit({ type: "message_end", message: execution.message });
      await emit({
        type: "tool_end",
        callId: call.id,
        name: call.name,
        status: execution.status,
        raw: execution.raw,
        content: execution.message.text,
      });
    }

    const info: TurnInfo = {
      turn: turn,
      toolCount: calls.length,
      hasAnswer: calls.length === 0,
    };
    await emit({ type: "turn_end", ...info });
    signal.throwIfAborted();

    for (const hook of hooks) {
      const reason = await hook.afterTurn?.({ ...info }, signal);
      signal.throwIfAborted();
      if (typeof reason === "string" && reason.trim() !== "") {
        return { status: "stopped", reason: reason, turns: turn };
      }
    }

    if (calls.length === 0) {
      return { status: "completed", answer: response.text, turns: turn };
    }
  }

  throw new Error(`已达到 ${maxTurns} 次模型请求的上限，本次任务尚未得到最终回答`);
}