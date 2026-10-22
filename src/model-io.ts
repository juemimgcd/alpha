import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { estimateMessages } from "./budget.ts";
import type { Budget } from "./budget.ts";
import type { Tool } from "./tools.ts";

export type ModelIO = {
  summarize: (messages: BaseMessage[], signal: AbortSignal) => Promise<AIMessage>;
  request: (messages: BaseMessage[], signal: AbortSignal) => Promise<AIMessage>;
};

export function createModelIO(
  modelName: string,
  apiKey: string,
  tools: readonly Tool[],
  budget: Budget,
  baseURL?: string,
): ModelIO {
  const model = new ChatOpenAI({
    model: modelName,
    apiKey: apiKey,
    configuration: { baseURL: baseURL },
    useResponsesApi: false,
    streaming: false,
    maxTokens: budget.outputTokens,
    maxRetries: 0,
    timeout: 60_000,
  });

  // 不绑定工具；摘要不进入主循环，也不产生 message_end。
  const summaryModel = new ChatOpenAI({
    model: modelName,
    apiKey: apiKey,
    configuration: { baseURL: baseURL },
    useResponsesApi: false,
    streaming: false,
    maxTokens: budget.summaryOutputTokens,
    maxRetries: 0,
    timeout: 60_000,
  });

  const declarations = tools.map((tool) => {
    return {
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
    };
  });
  const modelWithTools = model.bindTools(declarations);

  const debugContext = process.env.ALPHA_DEBUG_CONTEXT === "1";
  let requestNumber = 0;

  return {
    async summarize(messages, signal) {
      signal.throwIfAborted();
      const tokens = estimateMessages(messages);
      const limit = budget.contextWindow - budget.summaryOutputTokens - budget.safetyTokens;
      if (tokens > limit) {
        throw new Error(`摘要输入估算 ${tokens} 超过预算 ${limit}`);
      }
      const response = await summaryModel.invoke(messages, { signal: signal });
      signal.throwIfAborted();
      if (debugContext) {
        console.error("[summary usage]", response.usage_metadata);
      }
      return new AIMessage({
        content: response.content,
        tool_calls: response.tool_calls,
        invalid_tool_calls: response.invalid_tool_calls,
        response_metadata: response.response_metadata,
        usage_metadata: response.usage_metadata,
      });
    },
    async request(messages, signal) {
      signal.throwIfAborted();
      const tokens = estimateMessages(messages);
      if (tokens > budget.messageLimit) {
        throw new Error(`请求前消息估算 ${tokens} 超过预算 ${budget.messageLimit}`);
      }
      requestNumber += 1;
      if (debugContext) {
        const snapshot = messages.map((message) => message.toDict());
        console.error(`[context] 第 ${requestNumber} 次请求，${messages.length} 条消息`);
        console.error(JSON.stringify(snapshot, null, 2));
      }
      const response = await modelWithTools.invoke(messages, { signal: signal });
      return new AIMessage({
        content: response.content,
        tool_calls: response.tool_calls,
        invalid_tool_calls: response.invalid_tool_calls,
        response_metadata: response.response_metadata,
        usage_metadata: response.usage_metadata,
        additional_kwargs: response.additional_kwargs,
        id: response.id,
      });
    },
  };
}