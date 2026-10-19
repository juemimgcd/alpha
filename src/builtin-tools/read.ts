import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../tools.ts";

export const readTool = defineTool({
  name: "read",
  description: "读取不超过 1 MB 的 UTF-8 文本文件。输出过长时截断。",
  schema: z.object({
    path: z.string().min(1).describe("相对工作目录的路径或绝对路径"),
  }),
  async execute(args, cwd, signal) {
    const fullPath = resolve(cwd, args.path);
    const info = await stat(fullPath);
    signal.throwIfAborted();

    if (!info.isFile()) {
      throw new Error("read 只能读取普通文件");
    }
    if (info.size > 1_000_000) {
      throw new Error("read 只读取不超过 1 MB 的文本文件");
    }

    const text = await readFile(fullPath, { encoding: "utf8", signal });
    signal.throwIfAborted();
    return text;
  },
});
