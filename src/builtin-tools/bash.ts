import { execFile } from "node:child_process";
import { z } from "zod";
import { defineTool, truncateOutput } from "../tools.ts";

export const bashTool = defineTool({
  name: "bash",
  description: "通过 /bin/bash 执行短时、非交互命令。不要启动后台任务或长期服务。",
  schema: z.object({
    command: z.string().min(1).max(10_000).describe("要交给 Bash 执行的命令"),
    timeoutMs: z.number().int().min(1).max(60_000).optional()
      .describe("超时毫秒数，默认 10000，最大 60000"),
  }),
  async execute(args, cwd, signal) {
    const timeoutMs = args.timeoutMs ?? 10_000;

    return await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "/bin/bash",
        ["--noprofile", "--norc", "-c", args.command],
        {
          cwd: cwd,
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: 1_000_000,
          killSignal: "SIGKILL",
          signal: signal,
        },
        (error, stdout, stderr) => {
          const output =
            `stdout:\n${truncateOutput(stdout, 5_000)}\n` +
            `stderr:\n${truncateOutput(stderr, 5_000)}`;

          if (error !== null) {
            const code = String(error.code ?? "unknown");
            const exitSignal = String(error.signal ?? "none");
            reject(new Error(
              `命令失败：${error.name}，code=${code}，signal=${exitSignal}\n${output}`,
            ));
            return;
          }

          resolve(`命令退出码：0\n${output}`);
        },
      );
      child.stdin?.end();
    });
  },
});