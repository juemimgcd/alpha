import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { toolCallSchema } from "./tools.ts";
import type { ToolCall } from "./tools.ts";
import { Tool } from "@langchain/core/tools";



export function responseCalls(message: AIMessage): ToolCall[] {
  const invalidCalls = message.invalid_tool_calls ?? [];
  if (invalidCalls.length > 0) {
    throw new Error("模型返回了无法解析的工具调用，本轮不执行工具");
  }

  const reason: unknown = message.response_metadata.finish_reason;
  if (reason !== undefined && reason !== "stop" && reason !== "tool_calls") {
    throw new Error(`模型响应未正常完成：${String(reason)}`);
  }
  if (typeof message.content !== "string") {
    throw new Error("Step 1 只处理文本内容，请使用支持文本工具调用的模型接口");
  }

  const calls: ToolCall[] = [];
  const ids = new Set<string>();

  for (const call of message.tool_calls ?? []) {
    const checkedCall = toolCallSchema.parse(call);
    if (ids.has(checkedCall.id)) {
      throw new Error(`同一响应中出现重复的工具调用 ID：${checkedCall.id}`);
    }

    ids.add(checkedCall.id);
    calls.push(checkedCall);
  }

  if (reason === "tool_calls" && calls.length === 0) {
    throw new Error("模型声明要调用工具，但没有返回有效调用");
  }
  if (reason === "stop" && calls.length > 0) {
    throw new Error("模型的结束原因与工具调用不一致");
  }
  if (calls.length === 0 && message.content.trim() === "") {
    throw new Error("模型既没有回答，也没有请求工具");
  }

  return calls;
}


export function validateHistory(messasges:BaseMessage[]): void{
  const pendingId = new Set<string>();
  for (const message of messasges){
    if (message instanceof ToolMessage){
      if (!pendingId.has(message.tool_call_id)){
        throw new Error();
      }
      pendingId.delete(message.tool_call_id);
      continue;
    }
    if (pendingId.size > 0){
      throw new Error();
    }
    if (message instanceof AIMessage){
      for (const call of message.tool_calls ?? []){
        if (typeof call.id !== "string" || call.id.trim() === "" || pendingId.has(call.id)){
          throw new Error();
        }
        pendingId.add(call.id)
      }
    }
  }
  if (pendingId.size > 0){
    throw new Error();
  }
}






