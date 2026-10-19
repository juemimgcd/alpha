# Step 2：让 Agent 写文件、精确修改和执行命令

[项目总览](summary.md) · [上一步：最小 Agent 循环](step1.md)

这一章接着 Step 1，给出需要新增或替换的 **10 个源码文件的完整内容**。你可以逐个保存、对照学习，不需要补 TODO。`package.json`、`tsconfig.json`、`src/protocol.ts` 和 `src/cli.ts` 沿用 Step 1，不需要新依赖。

本文件是教程。把下面代码保存到相应路径后，Alpha 才具备本章能力。

## 1. 先看这一章要完成的任务

假设你对 Agent 说：

> 在 `.alpha/practice/greeting.txt` 写入 `hello alpha`，再把其中的 `alpha` 改成 `coding agent`，最后读取文件，并运行命令确认文件内容。

典型过程是：

```text
用户要求
  → 模型请求 write：创建文件
  → Alpha 执行 write，返回 ToolMessage
  → 模型请求 edit：精确替换一段文字
  → Alpha 执行 edit，返回 ToolMessage
  → 模型请求 read / bash：核对结果
  → Alpha 返回文件内容 / 命令输出
  → 模型根据结果回答
```

模型决定请求什么工具，Alpha 决定怎样校验和执行。模型也可能一次提出多个调用；本章仍按返回顺序串行执行。

本章的四个工具：

| 工具 | 参数示例 | 实际行为 |
| --- | --- | --- |
| `read` | `{ path: "a.txt" }` | 读取小型 UTF-8 文本文件 |
| `write` | `{ path: "a.txt", content: "hello" }` | 创建或完整覆盖文件，自动创建父目录 |
| `edit` | `{ path: "a.txt", oldText: "hello", newText: "hi" }` | 仅当旧文字出现一次时替换 |
| `bash` | `{ command: "pwd", timeoutMs: 10000 }` | 启动 Bash 执行命令，收集输出 |

`write` 是整份内容写入；修改已有文件的一小段时，先 `read`，再 `edit`。`edit` 找不到旧文字或发现多处匹配时返回错误，不猜测应该改哪一处。

本章工具直接使用当前进程的文件和命令权限，练习放在 `.alpha/practice`。这个目录只是约定，不是沙箱；写入和命令的副作用不会因取消而自动撤销。

## 2. 为什么要增加统一调度

Step 1 的 `executeTool()` 只认识 `read`，模型绑定也直接写 `[readTool]`。新增三个工具以后，需要让两处使用同一份工具集合，否则可能出现“模型看得到工具，本地却找不到”的情况。

现在由 `app.ts` 创建集合，并分别交给模型适配层和 Agent：

```text
app.ts：tools = [readTool, writeTool, editTool, bashTool]
  ├─ createModelIO(..., tools)
  │    → 只取 name / description / schema，交给 bindTools
  └─ new Agent(model, tools, cwd)
       → runLoop(..., tools, ...)
            → executeTool(call, tools, cwd, signal)
                 → 按名称查找
                 → 运行统一入口：校验参数 → 执行具体函数
                 → 构造 ToolMessage
```

这里的“调度”就是根据 `call.name` 找到工具并调用。先用数组和 `find()`，四个固定工具不需要插件注册系统。

### 2.1 与 pi 对照

| 本地 pi 源码 | 本章借鉴的职责 | 教学版范围 |
| --- | --- | --- |
| [write.ts](/Users/jquery/python_files/pi/packages/coding-agent/src/core/tools/write.ts) | 创建父目录，写入完整内容 | 只写 UTF-8 文本，不接远程文件操作 |
| [edit.ts](/Users/jquery/python_files/pi/packages/coding-agent/src/core/tools/edit.ts) | 检查旧内容后精确修改 | 每次只替换一个唯一片段，不支持批量 edits、换行归一化或 diff 展示 |
| [bash.ts](/Users/jquery/python_files/pi/packages/coding-agent/src/core/tools/bash.ts) | 工作目录、输出收集、超时、取消 | 使用 Node `execFile`，不实现 pi 的输出落盘和进程树管理 |

这里模仿职责关系，不复制 pi 的全部工具接口。尤其是 `bash` 的取消范围，见第 5.4 节。

### 2.2 新文件和替换文件

```text
src/
├─ tools.ts                # 替换：工具类型、参数适配、输出截断
├─ dispatch.ts             # 新增：查找工具、返回 ToolMessage
├─ builtin-tools/
│  ├─ read.ts              # 替换：接入相同工具接口
│  ├─ write.ts             # 新增
│  ├─ edit.ts              # 新增
│  └─ bash.ts              # 新增
├─ model-io.ts             # 替换：接收工具集合
├─ agent-loop.ts           # 替换：调用 dispatch
├─ agent.ts                # 替换：保存并传递工具集合
├─ app.ts                  # 替换：组装四个工具
├─ protocol.ts             # 沿用 Step 1
└─ cli.ts                  # 沿用 Step 1
```

先读懂 `write → dispatch → loop` 这条链，再看 `bash` 的回调。下面按被调用模块在前的顺序给出完整代码。

## 3. src/tools.ts：让不同参数的工具有相同入口

四个工具的参数不同：`read` 需要 `path`，`write` 还需要 `content`。但调度器拿到的 `call.args` 仍是 `unknown`，必须先经过对应 schema 才能交给具体函数。

我们用一个小函数 `defineTool()` 连接这两种视角：对调度器接收 `unknown`，对具体执行函数提供已经检查好的参数。

<!-- file: src/tools.ts -->
```ts
import { z } from "zod";

export const toolCallSchema = z.object({
  id: z.string().refine((value) => value.trim() !== "", "工具调用缺少有效 ID"),
  name: z.string().refine((value) => value.trim() !== "", "工具调用缺少有效名称"),
  args: z.unknown(),
});

export type ToolCall = z.infer<typeof toolCallSchema>;

export type Tool = {
  name: string;
  description: string;
  schema: z.ZodType;
  execute: (raw: unknown, cwd: string, signal: AbortSignal) => Promise<string>;
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
    async execute(raw, cwd, signal) {
      signal.throwIfAborted();
      const args = definition.schema.parse(raw);
      return await definition.execute(args, cwd, signal);
    },
  };
}

export function truncateOutput(text: string, limit: number = 12_000): string {
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit) + `\n[输出已截断：只保留前 ${limit} 个 UTF-16 代码单元]`;
}
```

### 3.1 先解释 `<Args>`

这是本章唯一需要自己写的泛型参数。**泛型就是让同一段类型描述接收不同的具体类型。** `Args` 是类型的名字，不是变量，也不会在运行时出现。

对 `write` 来说，可以把 `ToolDefinition<Args>` 想成下面这个具体形状：

```ts
type WriteArgs = { path: string; content: string };

// 只用于解释，不是另一份需要保存的代码。
type WriteDefinition = {
  name: string;
  description: string;
  schema: z.ZodType<WriteArgs>;
  execute: (
    args: WriteArgs,
    cwd: string,
    signal: AbortSignal,
  ) => Promise<string>;
};
```

`z.ZodType<WriteArgs>` 表示这个 schema 校验成功以后会返回 `WriteArgs`。同一个 `Args` 同时出现在 schema 和 execute 的参数位置，让 TS 检查两者是否一致。调用 `defineTool()` 时通常不用手填 `<WriteArgs>`，TS 会从 schema 推导。

它解决的具体问题是：不能仅把 `call.args` 断言成某种类型就去写文件。代码需要真的运行 `parse()`，再把结果交给对应函数。

### 3.2 两个 execute 分别是谁

`defineTool()` 返回一个新对象，新对象的 `execute` 包住原来的 `definition.execute`：

```text
dispatch 调用 tool.execute(call.args, cwd, signal)
  → 进入 defineTool 返回的包装函数
  → definition.schema.parse(raw)
  → 得到已校验的 args
  → definition.execute(args, cwd, signal)
  → 进入 write.ts / read.ts 等文件中的具体函数
```

这里没有递归：`tool.execute` 和 `definition.execute` 是两个不同函数。包装函数通过闭包记住 `definition`，与 Step 1 中 `request()` 记住模型对象是同一种写法。

工具参数只在这个入口 parse 一次。`dispatch.ts` 不再 parse，具体工具也不重复 parse。`protocol.ts` 仍负责调用 ID、响应状态、历史消息配对；这些检查不会搬进工具。

`truncateOutput()` 被命令工具和调度器共同使用。它限制交给模型的文本长度，不能限制文件读取量；文件大小与子进程缓冲区分别检查。

## 4. 文件工具的完整实现

### 4.1 src/builtin-tools/read.ts：读取小型文本

<!-- file: src/builtin-tools/read.ts -->
```ts
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
```

现在声明和执行函数放在同一个工具对象里，不再单独导出 `executeRead()`。长输出由 `dispatch.ts` 统一截断，所以这里返回读到的文本。

`stat()` 的大小单位是字节；`text.length` 的单位是 UTF-16 代码单元，两者不同。与 Step 1 一样，读取前的大小检查不能防止文件在检查后被其他进程增大。

### 4.2 src/builtin-tools/write.ts：创建或覆盖

<!-- file: src/builtin-tools/write.ts -->
```ts
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
```

顺着一次调用看：

```text
args.path = ".alpha/practice/greeting.txt"
  → resolve(cwd, args.path)：得到完整文件路径
  → dirname(fullPath)：得到父目录
  → mkdir(..., { recursive: true })：补齐尚不存在的父目录
  → writeFile(...)：写入全部内容
  → 返回结果字符串
  → dispatch 把字符串包装成 ToolMessage
```

`content` 允许空字符串，因为清空文件也是明确的写入。`path` 不允许空字符串。这里不会先读原文件，也不会自动追加内容。

### 4.3 src/builtin-tools/edit.ts：只替换唯一匹配

<!-- file: src/builtin-tools/edit.ts -->
```ts
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../tools.ts";

export const editTool = defineTool({
  name: "edit",
  description: "精确替换小型 UTF-8 文件中的一段文字。oldText 必须非空且仅出现一次。请先 read。",
  schema: z.object({
    path: z.string().min(1).describe("已有文件路径"),
    oldText: z.string().min(1).max(100_000).describe("要替换的精确旧文字"),
    newText: z.string().max(100_000).describe("新文字；空字符串表示删除该片段"),
  }),
  async execute(args, cwd, signal) {
    const fullPath = resolve(cwd, args.path);
    const info = await stat(fullPath);
    signal.throwIfAborted();

    if (!info.isFile() || info.size > 1_000_000) {
      throw new Error("edit 只处理不超过 1 MB 的普通文本文件");
    }

    const text = await readFile(fullPath, { encoding: "utf8", signal });
    signal.throwIfAborted();
    const first = text.indexOf(args.oldText);
    if (first === -1) {
      throw new Error("没有找到 oldText，请重新读取文件并提供精确文字");
    }
    if (text.indexOf(args.oldText, first + 1) !== -1) {
      throw new Error("oldText 出现不止一次，请提供更长且唯一的上下文");
    }

    const before = text.slice(0, first);
    const after = text.slice(first + args.oldText.length);
    const updated = before + args.newText + after;
    signal.throwIfAborted();
    await writeFile(fullPath, updated, { encoding: "utf8", signal });
    signal.throwIfAborted();
    return `已在 ${args.path} 中替换 1 处文字`;
  },
});
```

`indexOf()` 返回第一个匹配的起始位置；找不到时返回 `-1`。假设文件是 `hello alpha`，`oldText` 是 `alpha`：

```text
first   = 6
before  = "hello "
newText = "coding agent"
after   = ""
updated = "hello coding agent"
```

第二次查找从 `first + 1` 开始，连重叠匹配也会发现。例如文件是 `aaa`，旧文字是 `aa`，位置 0 和 1 都匹配，应该拒绝。

这里用拼接而不直接 `replace(oldText, newText)`，使新文字里的 `$&` 等字符也按原样写入，不被字符串替换规则解释。

匹配包含空格和换行，必须完全一致。文件不存在、找不到文字、多处匹配都抛出异常，由调度器转成失败消息。

三个文件工具都没有文件锁、原子替换或回滚。串行 Loop 可以避免本次任务自己的工具同时写同一个文件，但不能防止别的进程修改文件；取消或写入失败也可能已经留下部分内容。练习时使用专门的小文件。

## 5. src/builtin-tools/bash.ts：把子进程结果交回 Agent

### 5.1 为什么执行命令需要新的异步写法

文件 API 已经返回 Promise，可以直接 `await readFile()`。这里选择的 `execFile()` 使用回调：子进程结束后，Node 调用我们传进去的函数，交给它错误、标准输出和标准错误输出。

所以要把回调包成 `Promise<string>`：

```text
调用 execute
  → new Promise：立即启动子进程
  → 等待 Node 调用回调
      ├─ 成功：resolve(输出字符串)
      └─ 失败：reject(Error)
  → 外层 await 得到字符串，或者抛出异常
```

`resolve`、`reject` 是 Promise 提供的两个函数。它们不是路径模块里的 `resolve()`；只是名字相同，所在作用域不同。

### 5.2 完整代码

<!-- file: src/builtin-tools/bash.ts -->
```ts
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
```

### 5.3 参数、输出和错误怎样对应

| 写法 | 含义 |
| --- | --- |
| `args.timeoutMs ?? 10_000` | 未提供超时时使用 10 秒；不是 10000 秒 |
| `execFile("/bin/bash", [...])` | 显式启动 Bash，由 `-c` 后的字符串提供命令 |
| `cwd` | 子进程开始执行时的工作目录 |
| `encoding: "utf8"` | 回调里的 stdout、stderr 使用字符串 |
| `maxBuffer: 1_000_000` | stdout 或 stderr 的缓冲超过限制会导致命令失败 |
| `signal` | 把 Agent 的取消信号传给 Node 子进程 API |
| `child.stdin?.end()` | 如果存在输入管道就关闭它，避免命令一直等终端输入 |
| `error !== null` | 启动失败、非零退出码、超时、缓冲超限或取消都走失败路径 |

`stdout` 是命令正常输出，`stderr` 是诊断输出。stderr 非空不一定代表失败；这里按 Node 返回的错误和进程退出状态判断。

本机交互终端是 zsh，但工具名叫 `bash`，因此明确调用 `/bin/bash`。每次调用都会创建新进程，某次执行 `cd` 不会改变下一次调用的工作目录。程序默认继承环境变量，包括 PATH；不加载常规 profile 和 bashrc。非交互 Bash 仍可能按环境变量 `BASH_ENV` 加载额外脚本，这不是一个隔离环境。

子进程输出先各保留 5000 个代码单元，避免 stdout 太长时完全挤掉 stderr。整个工具消息还会经过调度器的最终截断。这里不保证 stdout 与 stderr 的原始交错顺序。

### 5.4 超时和取消的实际范围

本章让 Node 在超时或取消时向直接子进程发送 `SIGKILL`。普通前台短命令适合这个练习，但这**不等于清理整个进程树**：命令启动的后代进程可能继续运行，继承的输出管道也可能影响等待结束的时间。因此 `timeoutMs` 不是所有复杂 shell 命令的严格总耗时保证。

不要用本章工具启动后台服务、守护进程或需要输入密码的交互命令。pi 的实现有额外的进程树处理；将来需要这些场景时再补齐相应能力。

非零退出码与信号终止都会保留 code、signal 和已捕获输出。收到 `SIGKILL` 本身不能证明一定是超时，也可能来自其他终止原因。

## 6. src/dispatch.ts：查找、执行、封装结果

<!-- file: src/dispatch.ts -->
```ts
import { ToolMessage } from "@langchain/core/messages";
import { truncateOutput } from "./tools.ts";
import type { Tool, ToolCall } from "./tools.ts";

export async function executeTool(
  call: ToolCall,
  tools: readonly Tool[],
  cwd: string,
  signal: AbortSignal,
): Promise<ToolMessage> {
  try {
    signal.throwIfAborted();
    const tool = tools.find((item) => item.name === call.name);
    if (tool === undefined) {
      throw new Error(`未知工具：${call.name}`);
    }

    const output = await tool.execute(call.args, cwd, signal);
    return new ToolMessage({
      content: truncateOutput(output),
      tool_call_id: call.id,
      name: call.name,
      status: "success",
    });
  } catch (error: unknown) {
    let message = String(error);
    if (error instanceof Error) {
      message = error.message;
    }

    return new ToolMessage({
      content: truncateOutput(`工具调用未成功：${message}`),
      tool_call_id: call.id,
      name: call.name,
      status: "error",
    });
  }
}
```

这一层从 Step 1 的 `tools.ts` 移出来，执行顺序仍然容易追踪：

```text
call.name = "write"
  → find 找到 writeTool
  → writeTool.execute(call.args, cwd, signal)
      → defineTool 的包装函数 parse 一次参数
      → write.ts 的 execute 真正写文件
  → 得到字符串
  → new ToolMessage({ tool_call_id: call.id, ... })
  → Loop 保存消息，下一轮交给模型
```

`find()` 接收一个判断函数，返回第一个使判断成立的元素；找不到时是 `undefined`。`readonly Tool[]` 表示这里可以读取数组，但不能用 `push()` 修改集合，不表示工具对象在运行时被冻结。

未知工具、参数错误和执行异常都转换成对应调用的错误消息。错误内容也截断，避免 Zod 报错或命令诊断无限挤占后续上下文。

取消仍沿用 Step 1 的规则：为当前整批调用补齐成功或失败结果，再由 Loop 停止。已经成功的写入不会撤销，后续尚未开始的工具会先检查 signal，不再执行实际操作。

## 7. 把工具集合接回模型、Loop 和 Agent

### 7.1 src/model-io.ts：模型只拿到声明

<!-- file: src/model-io.ts -->
```ts
import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import type { Tool } from "./tools.ts";

export type ModelIO = {
  request: (messages: BaseMessage[], signal: AbortSignal) => Promise<AIMessage>;
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
```

`map()` 遍历工具数组，为每个工具创建一份声明，组成新数组。这里没有调用任何 `execute()`。`declarations` 不包含执行函数，LangChain 只用它把工具结构告诉模型。

注意参数顺序改成了 `createModelIO(modelName, apiKey, tools, baseURL)`，下面的 `app.ts` 会同步调整。

### 7.2 src/agent-loop.ts：循环不关心具体工具

<!-- file: src/agent-loop.ts -->
```ts
import type { BaseMessage } from "@langchain/core/messages";
import { executeTool } from "./dispatch.ts";
import type { ModelIO } from "./model-io.ts";
import { responseCalls, validateHistory } from "./protocol.ts";
import type { Tool } from "./tools.ts";

export async function runLoop(
  messages: BaseMessage[],
  model: ModelIO,
  tools: readonly Tool[],
  cwd: string,
  maxTurns: number,
  signal: AbortSignal,
): Promise<string> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    signal.throwIfAborted();
    validateHistory(messages);

    const response = await model.request(messages, signal);
    signal.throwIfAborted();
    const calls = responseCalls(response);
    messages.push(response);

    if (calls.length === 0) {
      return response.text;
    }

    for (const call of calls) {
      const result = await executeTool(call, tools, cwd, signal);
      messages.push(result);
    }
    signal.throwIfAborted();
  }

  throw new Error(`已达到 ${maxTurns} 次模型请求的上限，本次任务尚未得到最终回答`);
}
```

与 Step 1 相比，只增加 `tools` 参数，并把 `executeTool` 的导入改到 `dispatch.ts`。Loop 不需要知道 `oldText`、`content` 或 `command` 的具体含义。

仍然是 `for...of` 内逐次 `await`。如果同一批调用是 write、edit、read，后一个会看到前一个完成后的文件；改成 `Promise.all()` 就无法保证这个顺序。

### 7.3 src/agent.ts：保存工具集合

<!-- file: src/agent.ts -->
```ts
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { runLoop } from "./agent-loop.ts";
import type { ModelIO } from "./model-io.ts";
import type { Tool } from "./tools.ts";

export class Agent {
  private messages: BaseMessage[];
  private model: ModelIO;
  private tools: readonly Tool[];
  private cwd: string;
  private maxTurns: number;
  private controller: AbortController | undefined;

  constructor(model: ModelIO, tools: readonly Tool[], cwd: string, maxTurns: number = 8) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new Error("maxTurns 必须是正整数");
    }

    this.model = model;
    this.tools = tools;
    this.cwd = cwd;
    this.maxTurns = maxTurns;
    this.controller = undefined;
    this.messages = [
      new SystemMessage(
        "你是 Alpha，一个模仿 pi1 的 coding agent demo。" +
        "你可以使用 read、write、edit、bash。涉及文件内容时先读取，不要猜测。" +
        "write 用于创建或完整覆盖；局部修改先 read 再 edit。" +
        "只执行用户任务所需的操作，修改完成后读取文件或运行合适命令核对。" +
        "bash 只运行短时非交互命令，不启动后台服务。" +
        "工具失败时根据错误调整；最终回答区分已经完成与尚未验证的内容。",
      ),
    ];
  }

  async prompt(input: string): Promise<string> {
    if (this.controller !== undefined) {
      throw new Error("Agent 正在运行，请等待结束后再提交输入");
    }
    if (input.trim() === "") {
      throw new Error("用户输入不能为空");
    }

    const controller = new AbortController();
    this.controller = controller;
    try {
      this.messages.push(new HumanMessage(input));
      return await runLoop(
        this.messages,
        this.model,
        this.tools,
        this.cwd,
        this.maxTurns,
        controller.signal,
      );
    } finally {
      this.controller = undefined;
    }
  }

  abort(): void {
    if (this.controller !== undefined) {
      this.controller.abort();
    }
  }
}
```

新增字段 `this.tools` 保存数组，`prompt()` 再传给 Loop。消息状态和取消状态的管理沿用 Step 1。

系统提示里的“先读取”“核对结果”是模型行为指导，不是代码强制的授权或执行顺序。真正的拦截规则将在 Step 3 的 Hook 中实现。

### 7.4 src/app.ts：一次组装，两处使用

<!-- file: src/app.ts -->
```ts
import { Agent } from "./agent.ts";
import { bashTool } from "./builtin-tools/bash.ts";
import { editTool } from "./builtin-tools/edit.ts";
import { readTool } from "./builtin-tools/read.ts";
import { writeTool } from "./builtin-tools/write.ts";
import { createModelIO } from "./model-io.ts";
import type { Tool } from "./tools.ts";

export function createAgent(cwd: string): Agent {
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

  const model = createModelIO(modelName, apiKey, tools, baseURL);
  return new Agent(model, tools, cwd, 8);
}
```

工具名称在组装时检查一次。若两个对象都叫 `read`，`find()` 只能选中第一个，模型声明也会产生歧义，因此直接停止启动。

工具集合创建后本章不会动态修改。`protocol.ts` 仍从 `tools.ts` 导入 `toolCallSchema` 和 `ToolCall`，所以不需要改它的导入；`cli.ts` 仍调用 `createAgent(process.cwd())`。

## 8. 按一次 edit 调用走完返回链

假设模型返回：

```text
{
  id: "call_edit_1",
  name: "edit",
  args: {
    path: ".alpha/practice/greeting.txt",
    oldText: "alpha",
    newText: "coding agent"
  }
}
```

调用链是：

```text
runLoop
  → responseCalls(response)
      → 检查响应，以及调用 ID / name / args 外层结构
  → messages.push(response)
  → executeTool(call, tools, cwd, signal)
      → find 找到 editTool
      → editTool.execute(call.args, cwd, signal)
          → defineTool 包装函数检查 signal
          → edit schema.parse(raw)：确认 path / oldText / newText
          → edit.ts 的 execute(args, cwd, signal)
              → 读取原文件
              → 确认 oldText 唯一
              → 拼接新内容，写回
              → 返回“已替换 1 处文字”
      → 创建 tool_call_id = "call_edit_1" 的 ToolMessage
  → messages.push(result)
  → 进入下一轮，模型看到修改结果
```

如果 `oldText` 出现两次，执行函数在写入前抛错。调度器返回 `status: "error"` 的 ToolMessage，调用 ID 仍是 `call_edit_1`。模型可以下一轮重新读取、提供更准确的片段。

失败并不自动证明文件没有变化。例如写入中途失败，与“查找旧文字失败、尚未开始写入”不同，需要重新检查文件。

## 9. 运行与手动核对

下面的模型任务会使用 `.env` 配置并产生真实模型请求。按章节保存代码后再运行；本章不新增测试框架或测试文件。

### 9.1 先检查连接是否正确

在 alpha 根目录运行：

```sh
cd /Users/jquery/ts_files/alpha
npm run check
npm start
```

第一条检查源码类型，第二条没有任务参数，只打印 CLI 用法。若提示 `executeTool` 没有导出，检查 Loop 是否已改为从 `dispatch.ts` 导入；若参数数量不匹配，检查 `createModelIO`、`Agent` 和 `runLoop` 的调用是否都同步更新。

### 9.2 跑完整文件操作

```sh
npm start -- "仅在 .alpha/practice 下操作：先用 write 把 greeting.txt 的内容设为 hello alpha，再 read 确认，然后用 edit 把 alpha 替换为 coding agent，再 read 核对。最后用 bash 执行 cat .alpha/practice/greeting.txt，报告结果。"
```

运行后自己在终端检查：

```sh
cat .alpha/practice/greeting.txt
```

文件内容应为 `hello coding agent`，没有末尾换行也正常。这条用户任务会明确覆盖同名练习文件。

仅凭最终文件内容，不能证明模型实际调用了所有指定工具。若要核对路径，在 `dispatch.ts` 的 `tool.execute(...)` 处打断点，检查 `call.name`、`call.args` 和返回消息；本章还没有工具事件日志。

### 9.3 观察失败怎样返回

可以分别输入这些任务：

| 任务 | 应观察到的工具行为 |
| --- | --- |
| 先 write 将 `.alpha/practice/repeated.txt` 设为 `alpha alpha`，再 edit 只把 `alpha` 改为 `beta`；失败后停止修复 | edit 报多处匹配，文件仍为 `alpha alpha` |
| 对已确认存在的 greeting.txt，用 edit 将一个文件中没有的片段替换成 `x`；失败后停止修复 | edit 报未找到旧文字，本次 edit 不写入 |
| 用 bash 执行 `node -e 'process.exit(3)'`，报告命令结果 | 工具失败，code 为 3，不能当成功 |
| 用 bash 执行 `exec node -e 'setTimeout(() => {}, 30000)'`，将 timeoutMs 设为 1000 | 直接子进程被终止，工具返回失败 |

超时例子使用 Bash 的 `exec`，让 Node 替换 Bash 进程，避免为了这个简单练习额外留下 shell 子进程关系。这里不是让你写新的测试文件。

模型可能不按提示请求工具，或在错误后自行修复；要区分“模型选择了什么”与“工具实现做了什么”，仍以断点中的实际调用为准。

### 9.4 取消

让模型调用上面的等待命令，把 timeoutMs 改为 60000；确认命令已启动后按 Ctrl+C。CLI 应报告取消，退出码为 130。已经完成的文件修改不会被回滚。

本章依然最多发起 8 次主模型请求。每次工具失败后模型再试一次，也会消耗轮数；达到上限时应明确失败，不能把半成品当作任务完成。

## 10. 学完后应该能回答

1. 模型看到的工具声明和本地 Tool 对象有什么区别？
2. `tools.find(...)` 的返回值为什么可能是 `undefined`？
3. `call.args` 在哪里从 unknown 变成有 path、oldText 等字段的对象？
4. `ToolDefinition<Args>` 中的两个 Args 为什么必须一致？
5. 为什么 `defineTool` 返回的 execute 和传入的 execute 不是同一个函数？
6. write 和 edit 各自适合哪种修改？为什么 edit 必须检查唯一匹配？
7. 子进程的回调怎样变成 Loop 可以 await 的 Promise？
8. stderr 非空、退出码非零和收到信号分别意味着什么？
9. 为什么本章不能把工具调用改成 Promise.all？
10. 为什么取消不等于回滚文件，也不等于杀掉整个进程树？

下一步在现有调用位置加入 Hook 与事件：工具参数校验后允许拦截，执行完成后通知上层。继续保留 `Agent → Loop → Dispatch → Tool`，不另建一套运行框架。

## 11. API 依据与本章验证

Node 的子进程回调、timeout、signal 和输出缓冲选项见 [child_process 官方文档](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)；写入和取消行为见 [文件系统官方文档](https://nodejs.org/api/fs.html#fspromiseswritefilefile-data-options)。Zod 的 parse 与类型推导见 [官方基础说明](https://zod.dev/basics)。接口同时以 alpha 已安装的 `@types/node`、Zod 和 LangChain 声明文件核对。

2026-10-19 的验证结果：

- 将本章 10 个完整源码代码块提取到独立临时目录，配合 alpha 当前的 `protocol.ts`、`cli.ts` 和项目配置进行检查。
- 复用 alpha 已安装的依赖，在 Node.js 26.7.0 下运行 `npm run check` 通过，无类型错误；没有新增依赖或验证一次全新安装。
- 在该临时目录运行无任务参数的 `npm start`，正确打印用法，退出码为 0，没有发起模型请求。
- 文档中的本地文件链接均存在。
- 本次只新增 `steps/step2.md`，没有覆盖 alpha 的练习源码，没有新增或修改测试文件。
- 未执行真实模型工具循环、实际文件写入与编辑、命令超时或 Ctrl+C 取消验收。类型检查和 CLI 启动不能代替这些运行行为的验证；请按第 9 节核对。
