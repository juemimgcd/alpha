import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { readTool } from "./builtin-tools/read.ts";

export const toolCallSchema = z.object({
  id: z.string().refine((value) => value.trim() !== "", "工具调用缺少有效 ID"),
  name: z.string().refine((value) => value.trim() !== "", "工具调用缺少有效名称"),
  args: z.unknown(),
});

export type ToolCall = z.infer<typeof toolCallSchema>;

export type PreparedTool = {
  args: unknown;
  execute: (cwd: string, signal: AbortSignal) => Promise<string>;
};

export type Tool = {
  name: string;
  description: string;
  schema: z.ZodType;
  prepare: (raw: unknown) => PreparedTool;
};
type ToolDefinition<Args> = {
  name: string;
  description: string;
  schema: z.ZodType<Args>;
  execute: (args: Args, cwd: string, signal: AbortSignal) => Promise<string>;
};

export function defineTool<Args>(definition: ToolDefinition<Args>): Tool {
  return {
    name: definition.name,
    description: definition.description,
    schema: definition.schema,
    prepare(raw) {
      const args = definition.schema.parse(raw);
      return {
        args: structuredClone(args),
        async execute(cwd, signal) {
          signal.throwIfAborted();
          return await definition.execute(args, cwd, signal);
        },
      };
    },
  };
}


export function truncateOutput(text: string, limit: number = 12_000): string {
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit) + `\n[输出已截断：只保留前 ${limit} 个 UTF-16 代码单元]`;
}









