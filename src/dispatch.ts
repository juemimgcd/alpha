import { ToolMessage } from "@langchain/core/messages";
import type { Hook, ToolStatus } from "./hooks.ts";
import { truncateOutput } from "./tools.ts";
import type { Tool, ToolCall } from "./tools.ts";


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
  let status:ToolStatus = "success";
  let raw = "";

  try{
    const tool = tools.find((tool) => tool.name === call.name);
    if (tool === undefined){
      throw new Error();
    }
    const prepare = tool.prepare(call.args);
    for (const hook of hooks){
      const reason = await hook.beforeTool?.({
        id:call.id,
        name:call.name,
        args:call.args,
        cwd:cwd
      },signal);
      signal.throwIfAborted();
      if (typeof reason === "string" && reason.trim() !== ""){
        status = "denied";
        raw = ``;
        break;
      }
    }
    if (status !== "denied"){
      raw = await prepare.execute(cwd,signal);
    } 
  }catch(error:unknown){
    status = "error";
    const detail = error instanceof Error ? error.message:String(error);
    raw = `${detail}`;
    throw error;
  }
  let content = raw;
  for (const hook of hooks){
    try{
        const replacement = await hook.afterTool?.({
        id:call.id,
        name:call.name,
        status:status,
        content:content,
        raw:raw,
      },signal);
      signal.throwIfAborted();
      if (typeof replacement === "string"){
        content = replacement;
      }
    }catch(error:unknown){
      status = "error";
      const detail = error instanceof Error ? error.message:String(error);
      raw = `${detail}`;
      break;
    }
  }
  if (status !== "success"){
    throw new Error();
  }
  const message = new ToolMessage({
    content: truncateOutput(content),
    tool_call_id: call.id,
    name: call.name,
    status: status === "success" ? "success" : "error",
  });
  return { message: message, status: status, raw: raw };
}

