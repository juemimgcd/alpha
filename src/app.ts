import { SystemMessage } from "@langchain/core/messages";
import { createBudget } from "./budget.ts";
import { Agent } from "./agent.ts";
import { AgentSession } from "./agent-session.ts";
import { bashTool } from "./builtin-tools/bash.ts";
import { editTool } from "./builtin-tools/edit.ts";
import { readTool } from "./builtin-tools/read.ts";
import { writeTool } from "./builtin-tools/write.ts";
import type { Hook } from "./hooks.ts";
import { createModelIO } from "./model-io.ts";
import { truncateOutput } from "./tools.ts";
import type { Tool } from "./tools.ts";

export async function createSession(cwd: string, filePath?: string): Promise<AgentSession> {
  const apiKey = process.env.OPENAI_API_KEY;
  const modelName = process.env.OPENAI_MODEL;
  const baseURL = process.env.OPENAI_BASE_URL;

  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error("请在 .env 中填写 OPENAI_API_KEY");
  }
  if (modelName === undefined || modelName.trim() === "") {
    throw new Error("请在 .env 中填写 OPENAI_MODEL");
  }

  const tools: Tool[] = [readTool, writeTool, editTool, bashTool];
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`工具名称重复：${tool.name}`);
    }
    names.add(tool.name);
  }

  const readOnly = process.env.ALPHA_READ_ONLY === "1";
  const stopAfterTurn = process.env.ALPHA_STOP_AFTER_TURN === "1";

  const hooks: Hook[] = [{
    beforeModel(messages) {
      if (readOnly) {
        return [
          ...messages.slice(0, 1),
          new SystemMessage("本次只读，只允许 read；write、edit、bash 都会被策略拒绝。"),
          ...messages.slice(1),
        ];
      }
    },
    afterModel(response) {
      const usage = response.usage_metadata;
      if (usage !== undefined) {
        console.error(`[usage] 输入 ${usage.input_tokens}，输出 ${usage.output_tokens}`);
      }
    },
    beforeTool(call) {
      if (readOnly && call.name !== "read") {
        return "本次只读，只允许 read";
      }
    },
    afterTool(result) {
      return truncateOutput(result.content, 8_000);
    },
    afterTurn(turn) {
      if (stopAfterTurn && !turn.hasAnswer) {
        return `练习策略：第 ${turn.turn} 轮工具结果已提交，暂不请求下一轮模型`;
      }
    },
  }];

  const budget = createBudget(tools);
  const model = createModelIO(modelName, apiKey, tools, budget, baseURL);
  const agent = new Agent(model, tools, cwd, hooks, 8);
  if (filePath !== undefined) {
    return await AgentSession.load(agent, cwd, filePath, model, budget);
  }
  return await AgentSession.create(agent, cwd, model, budget);
}