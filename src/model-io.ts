import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI, OpenAI } from "@langchain/openai";
import { readTool } from "./builtin-tools/read.ts";
import type { Tool } from "./tools.ts";


export type ModelIO = {
  request:(messages:BaseMessage[],signal:AbortSignal) => Promise<AIMessage>;
};

export function createModelIO(
  modelName: string,
  apiKey: string,
  tools: readonly Tool[],
  baseURL?: string,
): ModelIO {
  const model = new ChatOpenAI({
    model: modelName,
    apiKey: apiKey,
    configuration: { baseURL: baseURL },
    useResponsesApi: false,
    streaming: false,
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
  return {
    async request(messages, signal) {
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