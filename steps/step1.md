# Step 1：从一次模型请求到会读文件的 Agent

[项目总览](summary.md)

这一章给出第一步的全部文件内容。你可以按路径保存后运行，不需要先补 TODO，也不会导入后面章节才提供的文件。

Alpha 是模仿 **pi1** 的教学 demo。这一步参考本地 pi 的 `Agent → agent-loop → 模型 / 工具` 调用关系，用 LangChain 替换模型通信和消息表示，用 Zod 检查工具调用对象与具体工具参数。

## 1. 先看我们要跑通什么

假设你对程序说：

> 读取 package.json，告诉我这个项目用了哪些依赖。

这里使用本章会创建的 `package.json`，所以不需要提前准备 README。

程序不是把这句话发送给模型一次就结束。它需要完成下面的过程：

```text
第一次请求：用户问题 + 工具说明
    ↓
模型：请执行 read，参数是 { path: "package.json" }
    ↓
Alpha：检查参数，真正读取本地文件
    ↓
第二次请求：原问题 + 模型的工具调用 + 文件内容
    ↓
模型：根据文件内容回答依赖有哪些
```

**模型返回工具调用时，文件还没有被读取。** 是 Alpha 调用 Node.js 的文件 API 完成读取，再把结果放进下一次模型请求。

这就是本章最重要的调用过程。先理解它，再看下面的模块。

### 1.1 四种消息分别装什么

下面是对象形状示意，不是需要另外保存的源码：

```ts
new SystemMessage("你是一个可以读取文件的助手。");

new HumanMessage("读取 package.json，告诉我有哪些依赖。");

new AIMessage({
  content: "",
  tool_calls: [
    { id: "call_1", name: "read", args: { path: "package.json" } },
  ],
});

new ToolMessage({
  content: "这里是实际读到的文件内容",
  tool_call_id: "call_1",
  name: "read",
});
```

| 对象 | 谁创建 | 保存什么 |
| --- | --- | --- |
| `SystemMessage` | Alpha | 对模型的长期工作说明 |
| `HumanMessage` | Alpha 根据用户输入创建 | 用户这一次的要求 |
| `AIMessage` | 模型适配层返回，Alpha 接收 | 模型回答，或者模型提出的工具调用 |
| `ToolMessage` | Alpha 执行工具后创建 | 工具结果，以及它对应的调用 ID |

`AIMessage` 不一定是最终答案。它可以没有回答文字，只包含 `tool_calls`。

`call_1` 是这一次调用的标识，`read` 是工具名称。模型可能连续调用两次 read，所以结果必须用 `tool_call_id` 对应具体调用，不能只用工具名对应。

`BaseMessage[]` 表示“消息对象的数组”，可以装上面这些消息。`BaseMessage` 来自 LangChain，不需要我们重新实现。

## 2. 这一章从 pi 学哪些部分

| pi 的实现 | 本章保留什么 | 本章简化什么 |
| --- | --- | --- |
| [Agent.prompt](/Users/jquery/python_files/pi/packages/agent/src/agent.ts:373) | Agent 保存消息，接收用户输入，启动循环 | 只接收字符串，不实现图片和输入队列 |
| [runPromptMessages](/Users/jquery/python_files/pi/packages/agent/src/agent.ts:432) | Agent 调用独立的循环函数 | 直接传入明确参数，不引入大量运行配置 |
| [runLoop](/Users/jquery/python_files/pi/packages/agent/src/agent-loop.ts:163) | 模型响应 → 工具执行 → 继续或结束 | 一个有上限的 for 循环，工具串行执行 |
| [streamAssistantResponse](/Users/jquery/python_files/pi/packages/agent/src/agent-loop.ts:381) | 模型通信集中在一个位置 | 使用 LangChain 的非流式 invoke |
| [prepareToolCall](/Users/jquery/python_files/pi/packages/agent/src/agent-loop.ts:707) | 找工具、检查参数后再执行 | 目前只有 read，直接使用 if；校验改用 Zod |
| [read 工具](/Users/jquery/python_files/pi/packages/coding-agent/src/core/tools/read.ts) | 工具说明、参数 schema、文件读取、输出限制 | 只读取小型 UTF-8 文本文件 |

pi 还会通过事件更新状态、保存消息。本章先让 Loop 修改 Agent 持有的消息数组；Step 3 再引入事件，Step 4 接入会话保存。这是明确的教学简化。

`AgentSession` 暂时不创建：本章还没有会话保存、输入扩展和压缩协调，添加一层只转发 `prompt()` 的类没有必要。后续加入它时，已有 `Agent → Loop` 主线继续保留。

## 3. 用到哪些 frontend 语法

| 本章写法 | 已学位置 | 在这里的用途 |
| --- | --- | --- |
| 对象、函数、参数、返回值 | [Day 3](/Users/jquery/frontend/days/day3.md) | 表达一次工具调用和函数输入输出 |
| `type`、可选字段、`unknown`、类型收窄 | [Day 3A](/Users/jquery/frontend/days/day3-types.md) | 描述对象，检查缺失值 |
| `export`、`import`、`import type` | [Day 4](/Users/jquery/frontend/days/day4.md) | 把各文件连接起来 |
| 函数作为值、对象方法 | [Day 5](/Users/jquery/frontend/days/day5.md) | 保存模型请求函数 |
| `class`、`constructor`、`this`、`private` | [Day 5D](/Users/jquery/frontend/days/day5-functions.md) | Agent 保存状态 |
| `async`、`await`、`try/catch/finally`、文件 API | [Day 6](/Users/jquery/frontend/days/day6.md) | 等待请求和文件读取，处理失败 |
| `Set`、数组引用 | [Day 5C](/Users/jquery/frontend/days/day5-collections.md) | 检查调用 ID，理解消息数组如何变化 |
| 工具查找与异步执行链 | [Day 8](/Users/jquery/frontend/days/day8.md)、[Day 9](/Users/jquery/frontend/days/day9.md) | 从调用要求找到函数，再等待结果 |

本章真正新增的是三个 API 概念：LangChain 消息与模型、Zod schema、`AbortController` / `AbortSignal`。它们会在使用的位置解释。

不要先研究 LangChain 声明文件里的复杂泛型。我们只在自己的接口里写 `BaseMessage[]`、`Promise<AIMessage>` 这些具体类型。

## 4. 创建目录和配置

本章最终使用这些文件：

```text
alpha/
├─ package.json
├─ tsconfig.json
├─ .gitignore
├─ .env                     # 你自己填写，不提交
├─ steps/
│  ├─ summary.md
│  └─ step1.md
└─ src/
   ├─ builtin-tools/read.ts
   ├─ tools.ts
   ├─ model-io.ts
   ├─ protocol.ts
   ├─ agent-loop.ts
   ├─ agent.ts
   ├─ app.ts
   └─ cli.ts
```

先在终端执行：

```sh
cd /Users/jquery/ts_files/alpha
mkdir -p src/builtin-tools
node --version
```

本章按当前本机 Node.js **26.7.0** 编写：直接运行 `.ts`，不生成 `dist`。本地导入统一写实际的 `.ts` 后缀，类型检查单独用 `tsc --noEmit`。

这沿用 [环境准备中的“直接运行 TS”说明](/Users/jquery/frontend/days/setup.md)，不要与编译成 JS 的 `.js` 导入方式混用。

### 4.1 package.json

下面固定的是本章核对的依赖版本，不表示必须追逐最新版本。

<!-- file: package.json -->
```json
{
  "name": "alpha-pi1-demo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=26.7.0 <27"
  },
  "scripts": {
    "start": "node --env-file-if-exists=.env src/cli.ts",
    "check": "tsc --noEmit"
  },
  "dependencies": {
    "@langchain/core": "1.2.18",
    "@langchain/openai": "1.6.2",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@types/node": "26.6.5",
    "typescript": "7.0.2"
  }
}
```

保存后，在 alpha 根目录运行：

```sh
npm install --ignore-scripts
```

`--ignore-scripts` 表示这次安装不执行依赖包的生命周期脚本。保留生成的 `package-lock.json`。

### 4.2 tsconfig.json

<!-- file: tsconfig.json -->
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- `strict`：严格检查我们写的类型。
- `noEmit`：只检查，不生成 JavaScript 文件。
- `allowImportingTsExtensions`：允许本地导入写 `.ts`。
- `verbatimModuleSyntax`：纯类型使用 `import type`，运行时对象使用普通 `import`。
- `erasableSyntaxOnly`：避免 Node 直接运行时不能只靠擦除类型处理的 TS 语法。
- `skipLibCheck`：不检查依赖声明文件内部，但仍根据这些声明检查我们的调用。

### 4.3 .gitignore

<!-- file: .gitignore -->
```gitignore
node_modules/
.env
.alpha/
```

### 4.4 .env：自己填写

```dotenv
OPENAI_API_KEY=填写你的接口密钥
OPENAI_MODEL=填写服务商支持工具调用的模型名称
# 使用兼容 Chat Completions 的服务时，按服务商要求填写完整 API 根地址。
# OPENAI_BASE_URL=https://你的服务商地址/v1
```

`ChatOpenAI` 在本章使用 Chat Completions 接口。服务端需要支持工具调用；仅能聊天的接口不能完成这一章。省略 `OPENAI_BASE_URL` 时使用适配器默认地址。

程序不硬编码模型名称，也不把密钥写进源码。`npm start` 会让 Node 读取当前目录的 `.env`，不需要再安装 dotenv。

## 5. 完整代码：先写被调用的部分

以下八份是本章需要保存的全部 TypeScript 源码。后面的短代码片段只用于解释，不要再拼进文件。

### 5.1 src/builtin-tools/read.ts：声明工具，读取文件

<!-- file: src/builtin-tools/read.ts -->
```ts
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const readTool = {
  name: "read",
  description: "读取一个小型 UTF-8 文本文件。path 可以是相对工作目录的路径或绝对路径。",
  schema: z.object({
    path: z.string().min(1).describe("要读取的文本文件路径"),
  }),
};

export async function executeRead(
  path: string,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const fullPath = resolve(cwd, path);
  const info = await stat(fullPath);
  signal.throwIfAborted();

  if (!info.isFile()) {
    throw new Error("read 只能读取普通文件");
  }
  if (info.size > 1_000_000) {
    throw new Error("Step 1 只读取不超过 1 MB 的文本文件");
  }

  const text = await readFile(fullPath, { encoding: "utf8", signal });
  signal.throwIfAborted();

  if (text.length > 12_000) {
    return text.slice(0, 12_000) + "\n[输出已截断：Step 1 只返回前 12000 个字符串代码单元]";
  }
  return text;
}
```

**谁调用它：** 后面的 `executeTool()`。

**输入：** 已校验的文件路径、工作目录和取消信号。

**返回：** `Promise<string>`；调用者 `await` 后拿到文件文本。

逐项读：

- `readTool` 是普通对象，`name`、`description`、`schema` 是三个属性。创建对象不会读文件。
- `z.object({ ... })` 创建运行时校验规则，`z.string().min(1)` 要求非空字符串。
- `.describe(...)` 给模型说明这个参数的意思，不执行任何工具。
- `executeRead` 是真正执行文件操作的函数；在另一个文件中才会调用。
- `cwd` 是工作目录，例如 `/Users/jquery/ts_files/alpha`。`resolve(cwd, "package.json")` 得到完整路径。
- `stat` 读取文件信息，`readFile` 读取内容。两者都是异步函数，所以分别 `await`。
- `1_000_000` 中的下划线只帮助阅读，数值就是 1000000。
- JS 的 `text.length` 计算 UTF-16 代码单元，不是字节或 token；这里的截断只是本章的简单输出限制。

这个 read 可以读取进程有权限读取的路径，`resolve` 不是目录沙箱。1 MB 检查也只是读取前的检查，文件在检查后变大时并不是严格的内存上限。本章用于自己选定的小型文本文件，后续再完善分页和受限读取。

### 5.2 src/tools.ts：把工具调用变成工具结果

<!-- file: src/tools.ts -->
```ts
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { executeRead, readTool } from "./builtin-tools/read.ts";

export const toolCallSchema = z.object({
  id: z.string().refine((value) => value.trim() !== "", "工具调用缺少有效 ID"),
  name: z.string().refine((value) => value.trim() !== "", "工具调用缺少有效名称"),
  args: z.unknown(),
});

export type ToolCall = z.infer<typeof toolCallSchema>;

export async function executeTool(
  call: ToolCall,
  cwd: string,
  signal: AbortSignal,
): Promise<ToolMessage> {
  try {
    signal.throwIfAborted();

    if (call.name !== readTool.name) {
      throw new Error(`未知工具：${call.name}`);
    }

    const args = readTool.schema.parse(call.args);
    const output = await executeRead(args.path, cwd, signal);

    return new ToolMessage({
      content: output,
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
      content: `工具调用未成功：${message}`,
      tool_call_id: call.id,
      name: call.name,
      status: "error",
    });
  }
}
```

`ToolCall` 是 Alpha 内部接收的、已确认有调用 ID 的小对象。它不是新造一套消息类型：外面的消息仍然是 LangChain 的 `AIMessage`，我们只是取出其中一条工具调用交给执行函数。

`toolCallSchema` 定义运行时规则，`ToolCall` 则从这份规则推导出 TS 类型：

```ts
export type ToolCall = z.infer<typeof toolCallSchema>;
```

这里的 `typeof toolCallSchema` 在类型位置表示“取得这个 schema 的类型”，`z.infer<...>` 再取得它校验成功后返回的数据类型。你可以先把这一行理解为：让 Zod 根据 schema 自动生成下面这个类型，不必手写两遍字段：

```ts
type ToolCall = {
  id: string;
  name: string;
  args: unknown;
};
```

`z.string()` 要求字符串；`.refine(...)` 增加自定义判断。这里传入的箭头函数接收字符串，返回 `true` 就通过，返回 `false` 就校验失败。`value.trim() !== ""` 排除空字符串和全空白字符串，但不修改原值。例如 `" call_1 "` 仍保留两侧空格，不能使用会改写 ID 的 `.trim()` schema。

`toolCallSchema` 由后面的 `responseCalls()` 调用；`executeTool()` 接收已经通过它检查的对象，不再重复检查整条调用。

`args: z.unknown()` 推导出的类型是 `unknown`，表示“此处尚未检查具体工具的参数”。关键两行仍然是：

```ts
const args = readTool.schema.parse(call.args);
const output = await executeRead(args.path, cwd, signal);
```

第一行运行 Zod 检查。成功时返回有 `path: string` 的对象，TS 也知道这个类型；失败时抛出异常，第二行不会执行。工具参数只在这里检查一次，`executeRead` 不再重复 parse。

第二行真正读文件。得到字符串后，包装成 `ToolMessage` 返回给 Loop。

这延续 Day 9 的“工具失败也可以变成明确的结果”。`status: "error"` 是本地消息状态；`content` 同时写明失败，确保模型从文本也能知道发生了什么。

当前只有 read，直接 `if` 比建立通用工具框架更容易理解。Step 2 增加工具后，再把这一段整理成工具集合与 `dispatch.ts`。

### 5.3 src/model-io.ts：LangChain 只完成一次请求

<!-- file: src/model-io.ts -->
```ts
import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { readTool } from "./builtin-tools/read.ts";

export type ModelIO = {
  request: (messages: BaseMessage[], signal: AbortSignal) => Promise<AIMessage>;
};

export function createModelIO(
  modelName: string,
  apiKey: string,
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
  const modelWithTools = model.bindTools([readTool]);

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

先读 `ModelIO`：

```ts
request: (messages: BaseMessage[], signal: AbortSignal) => Promise<AIMessage>;
```

它表示：这个对象有一个叫 `request` 的函数属性，函数接收消息数组和取消信号，异步返回一条模型消息。这里的 `=>` 用在类型描述中，不是在执行箭头函数。

再读 `createModelIO()`：

1. `new ChatOpenAI(...)` 创建模型适配器，不发送请求。
2. `model.bindTools([readTool])` 创建带有工具声明的调用对象，也不读文件。
3. `return { async request(...) { ... } }` 返回一个普通对象，对象里有一个异步方法。
4. 以后调用 `io.request(...)`，才执行 `modelWithTools.invoke(...)`，发起一次请求。

`request` 能继续访问外层的 `modelWithTools`，就是 Day 5D 学过的闭包。我们不用在字段类型里写一长串 LangChain 的泛型。

`bindTools` 使用 `name`、`description`、`schema` 把工具说明交给模型。本地 `executeRead` 没有传给 LangChain，执行权一直在 Alpha。

这里核对的适配器版本中，`invoke()` 的返回类型名是 `AIMessageChunk`，但非流式 `invoke()` 等待的是完整结果，不是单个 token 片段。我们把所需内容和元数据交给 `new AIMessage(...)`，在本章内部统一使用普通 `AIMessage`。这不是手写另一套消息协议。

`maxRetries: 0` 让第一步的请求次数更容易追踪；失败直接交给调用者。`timeout: 60_000` 是单次请求的超时配置。它们与 Loop 的“最多请求几轮”是不同限制。

### 5.4 src/protocol.ts：消息与调用的检查集中放这里

先记住两个不同问题：

- `responseCalls()`：新收到的模型响应能不能使用？其中有哪些可执行调用？
- `validateHistory()`：即将发出的历史里，工具调用与结果是否配对？

它们属于同一个协议检查模块。工具参数中的 `path` 是否正确，则由前面的 Zod schema 负责。

<!-- file: src/protocol.ts -->
```ts
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { toolCallSchema } from "./tools.ts";
import type { ToolCall } from "./tools.ts";

export function responseCalls(message: AIMessage): ToolCall[] {
  const invalidCalls = message.invalid_tool_calls ?? [];
  if (invalidCalls.length > 0) {
    throw new Error("模型返回了无法解析的工具调用，本轮不执行工具");
  }

  const reason: unknown = message.response_metadata.finish_reason;
  if (reason !== undefined && reason !== "stop" && reason !== "tool_calls") {
    throw new Error(`模型响应未正常完成：${String(reason)}`);
  }
  if (typeof message.content !== "string") {
    throw new Error("Step 1 只处理文本内容，请使用支持文本工具调用的模型接口");
  }

  const calls: ToolCall[] = [];
  const ids = new Set<string>();

  for (const call of message.tool_calls ?? []) {
    const checkedCall = toolCallSchema.parse(call);
    if (ids.has(checkedCall.id)) {
      throw new Error(`同一响应中出现重复的工具调用 ID：${checkedCall.id}`);
    }

    ids.add(checkedCall.id);
    calls.push(checkedCall);
  }

  if (reason === "tool_calls" && calls.length === 0) {
    throw new Error("模型声明要调用工具，但没有返回有效调用");
  }
  if (reason === "stop" && calls.length > 0) {
    throw new Error("模型的结束原因与工具调用不一致");
  }
  if (calls.length === 0 && message.content.trim() === "") {
    throw new Error("模型既没有回答，也没有请求工具");
  }

  return calls;
}

export function validateHistory(messages: BaseMessage[]): void {
  const pendingIds = new Set<string>();

  for (const message of messages) {
    if (message instanceof ToolMessage) {
      if (!pendingIds.has(message.tool_call_id)) {
        throw new Error("历史中出现了没有对应调用的工具结果");
      }
      pendingIds.delete(message.tool_call_id);
      continue;
    }

    if (pendingIds.size > 0) {
      throw new Error("工具结果还没有补齐，就出现了另一条普通消息");
    }

    if (message instanceof AIMessage) {
      for (const call of message.tool_calls ?? []) {
        if (typeof call.id !== "string" || call.id.trim() === "" || pendingIds.has(call.id)) {
          throw new Error("历史中的工具调用 ID 无效或重复");
        }
        pendingIds.add(call.id);
      }
    }
  }

  if (pendingIds.size > 0) {
    throw new Error("工具结果还没有补齐，不能请求模型");
  }
}
```

这个文件相对长，可以先把它看成两个已经提供的检查函数，读懂主循环后再回来逐行看。

**Zod 校验发生在这里，push 只负责收集结果：**

```ts
const checkedCall = toolCallSchema.parse(call);
```

这类似 Pydantic 的 `ToolCall.model_validate(call)`：成功时返回符合规则的对象，失败时抛出 `ZodError`。区别是这里得到普通对象，可以直接访问 `checkedCall.id`、`checkedCall.name`，不需要额外调用 `model_dump()`。普通 `z.object` 也会去掉未声明的外层字段，因此结果只保留 `id`、`name`、`args`；`args` 的具体内容留给工具自己的 schema 检查。

以一次 read 调用为例：

```text
runLoop 收到 AIMessage
  → responseCalls(response)
      → 先检查 invalid_tool_calls、finish_reason 和文本内容
      → 从 tool_calls 取出 call
      → toolCallSchema.parse(call)
          → id 必须是字符串，且不能全为空白
          → name 必须是字符串，且不能全为空白
          → args 暂时作为 unknown 接收
          → 返回 checkedCall
      → ids.has(checkedCall.id) 检查同一响应内是否重复
      → ids.add(checkedCall.id) 记住已出现的 ID
      → calls.push(checkedCall) 收集校验后的对象
      → 检查结束原因与调用数量是否一致，以及最终回答是否为空
      → 返回 calls
  → 保存 AIMessage
  → executeTool(checkedCall, cwd, signal)
      → 检查工具名是否存在
      → readTool.schema.parse(checkedCall.args) 检查 read 的 path
      → executeRead(...) 真正读取文件
```

`parse()` 不执行工具；`push()` 也不执行工具。重复 ID 涉及同一批调用之间的关系，继续由 `Set` 检查。响应结束原因和历史消息配对检查也保留在原来的位置。

这两次 `parse()` 检查不同层次：`toolCallSchema` 检查“是哪次调用、调用什么工具”；`readTool.schema` 检查“read 所需的路径参数是否有效”。因此，缺失 ID 会终止本轮响应处理，而合法 read 调用中的错误路径参数会被 `executeTool()` 转成错误 ToolMessage，交给下一轮模型处理。

`responseCalls()` 会先检查**整条响应**，再返回调用数组。假设同一条响应有两个工具调用，第二个 ID 无效，第一项也不会提前执行。

检查 `finish_reason` 是为了防止把因输出限制而截断的参数拿去执行。当前版本若提供这个字段，就只接纳本章认识的正常原因；缺省时只能依赖其他字段检查，不能宣称已经识别所有兼容服务的截断行为。

schema 的 `.refine()` 和历史检查中的 `trim()` 都只用来判断是否全为空白，没有改写模型原始 ID。调用与结果仍使用原始字符串。

`validateHistory()` 中的 `Set` 可以理解为“还欠哪些调用结果”：

```text
遇到 AIMessage 的 call_1、call_2 → pendingIds = { call_1, call_2 }
遇到 call_1 的 ToolMessage       → pendingIds = { call_2 }
遇到 call_2 的 ToolMessage       → pendingIds = { }
```

集合清空以后才允许出现普通消息或发起下一次请求。`instanceof` 帮我们判断当前消息是哪一种，并让 TS 在分支内允许访问该类型的属性。

这不是通用的所有服务商协议验证器，只覆盖本章生成的文本消息和工具调用关系。

### 5.5 src/agent-loop.ts：真正的 Agent 循环

<!-- file: src/agent-loop.ts -->
```ts
import type { BaseMessage } from "@langchain/core/messages";
import type { ModelIO } from "./model-io.ts";
import { responseCalls, validateHistory } from "./protocol.ts";
import { executeTool } from "./tools.ts";

export async function runLoop(
  messages: BaseMessage[],
  model: ModelIO,
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
      const result = await executeTool(call, cwd, signal);
      messages.push(result);
    }

    signal.throwIfAborted();
  }

  throw new Error(`已达到 ${maxTurns} 次模型请求的上限，本次任务尚未得到最终回答`);
}
```

主线只有五件事：

1. 检查是否取消，以及历史是否完整。
2. 等待模型返回一条响应。
3. 检查响应，把它放进消息数组。
4. 如果没有工具调用，返回回答。
5. 如果有工具调用，依次执行并追加结果，然后进入下一轮。

`response.text` 是 LangChain 消息提供的文本访问属性。本章已经在 `responseCalls()` 中限制了文本内容并排除了空的最终回答。

最容易漏掉的是 `messages.push(response)`：工具结果之前必须保存“模型提出了哪次调用”。只保存 ToolMessage，会变成一个没有来由的结果。

这里的 `for...of` 加 `await` 表示串行执行。即使模型一次返回多个调用，也是前一个得到结果后才执行下一个。

`return response.text` 会直接结束整个 `runLoop`，不是仅跳过当前循环。`Promise<string>` 表示调用者必须等待它，才能拿到最后的字符串。

### 5.6 src/agent.ts：保存状态，启动和取消运行

<!-- file: src/agent.ts -->
```ts
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { runLoop } from "./agent-loop.ts";
import type { ModelIO } from "./model-io.ts";

export class Agent {
  private messages: BaseMessage[];
  private model: ModelIO;
  private cwd: string;
  private maxTurns: number;
  private controller: AbortController | undefined;

  constructor(model: ModelIO, cwd: string, maxTurns: number = 8) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new Error("maxTurns 必须是正整数");
    }

    this.model = model;
    this.cwd = cwd;
    this.maxTurns = maxTurns;
    this.controller = undefined;
    this.messages = [
      new SystemMessage(
        "你是 Alpha，一个模仿 pi1 的 coding agent demo。" +
        "你目前只有 read 工具。涉及文件内容时先读取文件，不要猜测。" +
        "工具失败时根据错误调整；回答时说明实际读到的内容。",
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

把这个类拆成三个部分读。

**字段：这个对象记住什么。** `messages` 保存历史，`model` 保存模型调用对象，`cwd` 保存路径基准，`maxTurns` 保存上限，`controller` 保存本次运行的取消控制器。

`private` 表示从类外访问这些字段时，TS 会报错。它是类型层面的访问约束，不是系统权限隔离。

**构造函数：创建时填入这些字段。**

```ts
const agent = new Agent(model, cwd, 8);
```

调用这行时，`constructor` 中的 `this` 指向新 Agent，`this.model = model` 把参数保存到该对象。`new Agent()` 不调用模型。

**方法：以后如何使用这些字段。**

`prompt()` 先放入 `HumanMessage`，再把同一个消息数组传给 `runLoop()`。数组没有被复制，所以 Loop 中的 `push()` 会反映到 `this.messages`。这对应 frontend 中对象和数组的引用行为。

这里写 `return await runLoop(...)` 是有原因的：需要等 Loop 成功或失败以后，才执行 `finally` 清理运行状态。如果直接 `return runLoop(...)`，这个 `finally` 会在异步任务完成之前执行。

同一个 Agent 对象在内存中可以先后调用多次 `prompt()`，保留之前消息；本章 CLI 每次只调用一次，退出进程后历史就消失。

### 5.7 src/app.ts：把对象组装起来

<!-- file: src/app.ts -->
```ts
import { Agent } from "./agent.ts";
import { createModelIO } from "./model-io.ts";

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

  const model = createModelIO(modelName, apiKey, baseURL);
  return new Agent(model, cwd, 8);
}
```

`process.env.OPENAI_API_KEY` 的类型可能是 `string | undefined`。`if` 检查以后，TS 才知道继续执行时它是字符串。这就是 Day 3A 的类型收窄。

`app.ts` 只负责创建和连接对象。它既不读取目标文件，也不决定循环是否继续。

### 5.8 src/cli.ts：从终端进入程序

<!-- file: src/cli.ts -->
```ts
import { createAgent } from "./app.ts";

async function main(): Promise<void> {
  const input = process.argv.slice(2).join(" ").trim();
  if (input === "") {
    console.log('用法：npm start -- "读取 package.json，说明项目依赖"');
    return;
  }

  const agent = createAgent(process.cwd());
  let interrupted = false;

  function onInterrupt(): void {
    interrupted = true;
    agent.abort();
  }

  process.on("SIGINT", onInterrupt);
  try {
    const answer = await agent.prompt(input);
    console.log(answer);
  } catch (error: unknown) {
    if (interrupted) {
      console.error("本次任务已取消");
      process.exitCode = 130;
    } else {
      throw error;
    }
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
```

`process.argv.slice(2)` 去掉 Node 路径和脚本路径，剩下用户参数。`join(" ")` 把它们合成一句输入。

`process.cwd()` 得到启动时的工作目录，所以命令要在 alpha 根目录运行。

`main()` 返回 Promise，末尾 `.catch(...)` 接住异步失败。`process.exitCode = 1` 表示本次程序失败退出，不会像直接强制退出那样立刻截断清理过程。

### 5.9 单独理解取消信号

取消链条如下：

```text
终端按 Ctrl+C
  → Node 触发 SIGINT
  → onInterrupt()
  → agent.abort()
  → controller.abort()
  → 同一个 signal 变为已取消
  → 模型请求 / 文件读取 / 循环检查观察到取消
```

- `AbortController` 是发出取消请求的对象。
- `controller.signal` 是传给其他函数的信号。
- `signal.throwIfAborted()`：如果已经取消，就抛出异常；否则继续。
- `process.on(...)` 注册处理函数，`process.off(...)` 在结束后移除它。

取消不会把普通 JavaScript 同步代码强行杀掉。函数需要检查信号，或者把信号传给支持取消的 API。

本章 `executeTool()` 会把工具异常转换成错误 ToolMessage。因此，取消发生在一批工具中间时，循环会为这批调用收集对应的失败结果，再由批次后的 `throwIfAborted()` 停止；不会带着缺少工具结果的消息发出下一次请求。具体取消错误来自底层 API，不等于每个工具都已成功执行。

## 6. 按真实调用顺序走一次

上面按“先写被调用部分”的顺序给代码。运行时从最后一个文件进入，顺序正好不同。

### 6.1 启动阶段：还没有网络请求

```text
cli.ts 的 main()
  → 从 argv 得到用户输入
  → createAgent(process.cwd())
      → 读取并检查环境变量
      → createModelIO(...)
          → 创建 ChatOpenAI
          → bindTools([readTool])
          → 返回带 request 方法的对象
      → new Agent(model, cwd, 8)
          → 创建 SystemMessage，保存到 messages
```

此时 `agent.messages` 内部只有一条系统消息。读入各个模块、创建工具对象、绑定工具说明，都没有执行 `executeRead()`。

### 6.2 第一轮：模型提出工具调用

```text
main()
  → await agent.prompt(input)
      → 加入 HumanMessage
      → await runLoop(messages, model, cwd, 8, signal)
          → validateHistory(messages)
          → await model.request(messages, signal)
              → await modelWithTools.invoke(messages, { signal })
              → 返回 AIMessage
          → responseCalls(response)
              → toolCallSchema.parse(call) 校验每条调用
              → 用 Set 检查重复 ID，收集 checkedCall
              → 检查响应一致性，返回 calls
          → messages.push(response)
```

假设模型返回 `read({ path: "package.json" })`，`responseCalls()` 返回：

```text
[
  {
    id: "call_1",
    name: "read",
    args: { path: "package.json" }
  }
]
```

真实 ID 由服务返回，不一定叫 `call_1`。

### 6.3 工具阶段：文件在这里才被读取

```text
runLoop()
  → await executeTool(call, cwd, signal)
      → 确认工具名是 read
      → readTool.schema.parse(call.args)
      → await executeRead(args.path, cwd, signal)
          → resolve 得到完整路径
          → stat 检查文件
          → readFile 读取 UTF-8 内容
          → 返回字符串
      → new ToolMessage({ content: output, tool_call_id: call.id, ... })
      → 返回 ToolMessage
  → messages.push(result)
```

注意三种返回值不同：`executeRead()` 返回文本，`executeTool()` 返回消息对象，`runLoop()` 最终返回模型的回答文本。

### 6.4 第二轮：模型看到结果并回答

外层 `for` 进入下一次迭代，重新执行 `model.request()`。这时消息数组已包含工具调用和结果。

| 时间点 | messages 中的内容 |
| --- | --- |
| 创建 Agent 后 | System |
| prompt 加入用户问题后 | System、Human |
| 第一轮模型返回后 | System、Human、AI（read 调用） |
| 文件读取完成后 | System、Human、AI（read 调用）、Tool（文件内容） |
| 第二轮模型回答后 | System、Human、AI（read 调用）、Tool（文件内容）、AI（最终回答） |

假设第二轮没有工具调用，`calls.length === 0`，答案沿调用链逐层返回：

```text
runLoop 返回字符串
  → Agent.prompt 等待完成并清理 controller
  → main 得到 answer
  → console.log(answer)
```

两次请求是这个例子的典型路径，不是固定次数。模型也可能需要多次读取；程序最多允许 8 次主模型请求。

## 7. 为什么这些代码需要分开

| 文件 | 输入 | 输出 / 改变 | 主要调用者 |
| --- | --- | --- | --- |
| `read.ts` | 路径、cwd、signal | 文件文本 | executeTool |
| `tools.ts` | 一条工具调用、cwd、signal | ToolMessage | runLoop |
| `model-io.ts` | 消息数组、signal | AIMessage | runLoop |
| `protocol.ts` | 响应或消息数组 | 调用数组，或检查失败异常 | runLoop |
| `agent-loop.ts` | 消息、模型、cwd、上限、signal | 追加消息，返回最终文本 | Agent.prompt |
| `agent.ts` | 模型、cwd、用户输入 | 保存状态，启动 / 取消任务 | main |
| `app.ts` | cwd、环境配置 | 组装好的 Agent | main |
| `cli.ts` | 终端参数 | 显示回答和退出状态 | Node |

这些文件各有真实工作，不是为了凑一个架构目录。初次阅读可以沿 `cli → app → agent → loop` 走；遇到模型、工具或检查，再跳到对应文件。

## 8. 运行与人工核对

保存全部文件、安装依赖并填写 `.env` 后，在 alpha 根目录运行：

```sh
npm run check
npm start
npm start -- "请先调用 read 读取 package.json，再列出 dependencies 和 devDependencies。"
```

- `npm run check` 检查八份源码的类型，不调用模型。
- `npm start` 没有任务参数，只打印用法，不要求密钥。
- 最后一条会实际请求你配置的模型，并可能产生服务费用。

`--` 告诉 npm：后面的内容交给程序。回答的措辞由模型决定，不要求和教程逐字一致。依赖列表应与刚才保存的 package.json 相符。

本章没有工具进度 UI，也没有事件日志。要确认真实执行过程，可以在编辑器中给 `model.request()`、`executeRead()` 和 `messages.push(result)` 设置断点，观察两轮请求前的消息数组。仅看到模型声称“读过了文件”，不能单独证明工具实际执行过。

再用一个你确认不存在的文件路径发起任务，观察工具错误如何回到模型。这里只提供人工核对方法，不新增测试文件、假模型或测试框架。

### 8.1 三种失败走不同路径

| 情况 | 代码怎样处理 |
| --- | --- |
| 文件不存在、参数错误、未知工具 | executeTool 返回错误 ToolMessage，模型下一轮可以根据错误调整 |
| 模型请求失败、响应不符合本章约定 | 抛出异常，结束本次运行，CLI 显示错误 |
| 超过 8 轮仍未得到回答 | Loop 抛出达到上限的错误，不能宣称任务完成 |

Ctrl+C 走取消信号，CLI 显示取消并使用退出码 130；普通错误使用退出码 1。

如果提示找不到 package.json，先检查终端所在目录。如果提示接口不支持参数或返回内容格式不支持，核对模型服务是否兼容本章的 Chat Completions 文本工具调用，不要用类型断言把错误压下去。

## 9. 本章完成后，应能解释什么

1. 为什么 `new ChatOpenAI()` 和 `bindTools()` 都还没有执行 read？
2. `await model.request(...)` 返回给谁？为什么还要进入下一轮？
3. 为什么 AI 的工具调用消息必须放在 ToolMessage 前面？
4. `args: unknown` 经过哪一行后，才能读取 `args.path`？
5. 为什么 `messages.push(...)` 会改变 Agent 保存的历史？
6. 为什么 `Agent.prompt()` 的 try/finally 中使用 `return await`？
7. 为什么工具失败可以交回模型，而请求失败直接结束运行？
8. 这一步与 pi 相似在哪里，又明确省略了哪些行为？
9. `toolCallSchema.parse(call)` 与 `readTool.schema.parse(call.args)` 分别检查什么？为什么 `push()` 本身不负责校验？

下一步加入 write、edit、bash，并把当前具体的工具分发整理成工具集合。后面的 Hook、Session、Context、Compact、Checkpoint 都继续接在这条执行链上。

## 10. API 依据与验证范围

LangChain 的 `ChatOpenAI`、`bindTools()`、`invoke()` 和自定义 base URL 用法已对照[官方适配器文档](https://docs.langchain.com/oss/javascript/integrations/chat/openai)及本机安装版本的类型声明。消息字段对照[官方消息文档](https://docs.langchain.com/oss/javascript/langchain/messages)；Zod 的 schema 和 `parse()` 行为对照[官方基础说明](https://zod.dev/basics)。

2026-10-18 的验证结果：

- 将本章 11 个完整文件代码块提取到独立临时目录，其中包括全部 8 份 TS 源码；本地文件链接均存在。
- 复用本机已安装、与上面版本一致的依赖，运行 `npm run check` 通过，没有类型错误。未在 alpha 中创建源码或安装依赖，也未验证一次全新安装。
- 工具调用对象改为 Zod 校验后，重新提取全部 8 份源码并运行 `npm run check` 通过。原有空白字段、重复 ID、响应一致性和历史配对规则已逐项对照；本次未新增测试或进行运行时验收。
- 运行 `npm start`，正确打印用法，退出码为 0。
- 移除环境中的模型与密钥配置后运行带任务参数的 CLI，正确提示缺少 `OPENAI_API_KEY`，退出码为 1，未发起模型请求。
- 未执行真实模型请求、模型驱动的文件读取循环或 Ctrl+C 取消验收；这些运行行为仍需按第 8 节使用实际配置核对。
