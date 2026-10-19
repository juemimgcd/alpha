import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../tools.ts";

export const writeTool = defineTool({
  name: "write",
  description: "创建或完整覆盖 UTF-8 文本文件，自动创建父目录。局部修改请使用 edit。",
  schema: z.object({
    path: z.string().min(1).describe("目标文件路径"),
    content: z.string().max(100_000).describe("文件的全部内容，最多 100000 个代码单元"),
  }),
  async execute(args, cwd, signal) {
    const fullPath = resolve(cwd, args.path);
    await mkdir(dirname(fullPath), { recursive: true });
    signal.throwIfAborted();

    await writeFile(fullPath, args.content, { encoding: "utf8", signal });
    signal.throwIfAborted();
    return `已写入 ${args.path}，内容长度为 ${args.content.length} 个 UTF-16 代码单元`;
  },
});