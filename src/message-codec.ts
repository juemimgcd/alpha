import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { z } from "zod";

const commonData = {
  content: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  additional_kwargs: z.record(z.string(), z.json()).default({}),
  response_metadata: z.record(z.string(), z.json()).default({}),
};

const savedToolCallSchema = z.object({
  id: z.string().refine((value) => value.trim() !== "", "工具调用 ID 不能为空"),
  name: z.string().refine((value) => value.trim() !== "", "工具名称不能为空"),
  args: z.record(z.string(), z.json()),
  type: z.literal("tool_call").optional(),
});

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  input_token_details: z.record(z.string(), z.number().nonnegative()).optional(),
  output_token_details: z.record(z.string(), z.number().nonnegative()).optional(),
});

export const savedMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("system"), data: z.object(commonData) }),
  z.object({ type: z.literal("human"), data: z.object(commonData) }),
  z.object({
    type: z.literal("ai"),
    data: z.object({
      ...commonData,
      tool_calls: z.array(savedToolCallSchema),
      invalid_tool_calls: z.array(z.never()).optional(),
      usage_metadata: usageSchema.optional(),
    }),
  }),
  z.object({
    type: z.literal("tool"),
    data: z.object({
      ...commonData,
      tool_call_id: z.string().refine((value) => value.trim() !== "", "工具结果缺少调用 ID"),
      status: z.enum(["success", "error"]),
    }),
  }),
]);

export type SavedMessage = z.infer<typeof savedMessageSchema>;

export function encodeMessage(message: BaseMessage): SavedMessage {
  // 转成真正能写入 JSON 的数据：可选字段的 undefined 会被省略。
  const raw: unknown = JSON.parse(JSON.stringify(message.toDict()));
  return savedMessageSchema.parse(raw);
}

export function decodeMessage(message: SavedMessage): BaseMessage {
  switch (message.type) {
    case "system":
      return new SystemMessage(message.data);
    case "human":
      return new HumanMessage(message.data);
    case "ai":
      return new AIMessage(message.data);
    case "tool":
      return new ToolMessage(message.data);
  }
}


