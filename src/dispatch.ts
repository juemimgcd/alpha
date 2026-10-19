import { ToolMessage } from "@langchain/core/messages";
import type { Hook, ToolStatus } from "./hooks.ts";
import { truncateOutput } from "./tools.ts";
import type { Tool, ToolCall } from "./tools.ts";
import { SingleRunExtractor } from "@langchain/core/utils/testing";

export type ToolExecution = {
  message: ToolMessage;
  status: ToolStatus;
  raw: string;
};

export async function executeTool(
  call: ToolCall,
  tools: readonly Tool[],
  hooks: readonly Hook[],
  cwd: string,
  signal: AbortSignal,
): Promise<ToolExecution> {
  let status: ToolStatus = "success";
  let raw = "";
  try{
    signal.throwIfAborted();
    const tool = tools.find((tool) => tool.name === call.name);
    if (tool === undefined){
      throw new Error();
    }
    const prepare = tool.prepare(call.args);

    for (const hook of hooks){
      const reason = await hook.beforeTool?.({
        id:call.id,
        name:call.name,
        cwd:cwd,
        args:prepare.args,
      },signal);
      signal.throwIfAborted();
      if (typeof reason === "string" && reason.trim() === ""){
        status = "denied";
        raw = ``;
        break;
      }
    }
    if (status !== "denied"){
      raw = await prepare.execute(cwd,signal);
    }
  }catch(error){
    status = "error";
    const detail = error instanceof Error ? error.message:String(error);
    raw = ``;
  }
  let content = raw;
  for (const hook of hooks){
    try{
      const replacement = await hook.afterTool?.({
        id:call.id,
        name:call.name,
        status:status,
        raw:raw,
        content:content,
      },signal);
      if (typeof replacement === "string"){
        content = replacement;
      }
    }catch(error){
      status = "error";
      const detail = error instanceof Error ? error.message : String(error);
      content = `工具结果处理失败：${detail}\n原始结果：\n${raw}`;
      break;
    }
  }
  if (status !== "success") {
    content = `[工具状态：${status}]\n${content}`;
  }
  const message = new ToolMessage({
    content: truncateOutput(content),
    tool_call_id: call.id,
    name: call.name,
    status: status === "success" ? "success" : "error",
  });
  return { message: message, status: status, raw: raw };
}

