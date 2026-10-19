# Step 3：用 Hook 参与执行，用事件观察过程

[项目总览](summary.md) · [上一步：coding 工具与统一调度](step2.md)

这一章接着 Step 2，给出 **8 个新增或替换文件的完整内容**。四个 `builtin-tools`、`model-io.ts`、`protocol.ts` 和项目配置沿用前两步，不新增依赖。本文件是教程，实际能力需要在你按路径保存代码后才会接入。

本章保留 `Agent → Loop → Dispatch → Tool`。Hook 用普通对象表达，在需要的位置逐个调用；事件订阅也使用普通函数，不引入插件管理器或另一套 Runtime。

## 1. 先看两个具体问题

### 1.1 模型想写文件，但这次只允许读取

Step 2 中，模型提出合法的 write 调用后，调度器就会执行。现在希望某次任务只读，即使模型仍然提出 write，也必须拒绝：

```text
模型：write({ path: "notes.txt", content: "hello" })
  → 调度器找到 write
  → Zod 检查参数
  → beforeTool：本次只读，返回拒绝原因
  → 跳过真正的文件写入
  → 为这次调用生成失败 ToolMessage
  → 模型下一轮看到原因，可以改为读取或解释限制
```

这是 Hook 的用途：在明确的位置参与决策。

只读练习会同时拒绝 write、edit 和 bash。仅拒绝 write 并不够，因为命令也可能修改文件。这里是当前四个工具的调用策略，不是操作系统沙箱，也不限制 read 能读取的路径范围。

### 1.2 终端需要知道 Agent 正在做什么

Step 2 只有最终回答，执行中看不到工具进度。现在希望终端出现这样的记录：

```text
[message_end] human
[message_end] ai
[tool_start] write call_1
[message_end] tool
[tool_end] write denied
[turn_end] 第 1 轮，1 次工具调用
[message_end] ai
[turn_end] 第 2 轮，0 次工具调用
[agent_end] completed
```

这是事件的用途：把已经到达的运行阶段通知 CLI，以后也可以通知会话保存模块。

`tool_start` 在本章表示“开始处理这次调用”，包括查找、校验和策略检查；它不能单独证明工具函数已经执行。`denied` 表示策略拒绝，`error` 表示校验或执行等环节失败。

## 2. Hook 和事件分别允许做什么

| 入口 | 输入 | 返回值由谁处理 |
| --- | --- | --- |
| `beforeModel` | 本轮消息副本、取消信号 | Loop 接收新的消息数组；不返回则沿用当前副本 |
| `afterModel` | 完整 AIMessage 的副本、取消信号 | 只观察，返回值不参与控制 |
| `beforeTool` | 调用信息和已校验参数的副本、取消信号 | Dispatch 将非空字符串作为拒绝原因 |
| `afterTool` | 原始结果、当前正文、状态、取消信号 | Dispatch 接收新的正文，保留调用身份和状态 |
| `afterTurn` | 已完成轮次的信息、取消信号 | Loop 将非空字符串作为停止原因 |
| 事件 listener | 事件副本 | Agent 等待回调结束，不把返回值当成控制指令 |

**拒绝一个工具，与停止整个任务不同。** `beforeTool` 拒绝后仍有对应结果，模型可以继续；`afterTurn` 停止后不再请求模型，返回值明确标记为 `stopped`。

本章所有 Hook 都允许同步或异步实现，多个 Hook 按数组顺序执行并等待。第一个明确拒绝工具的 Hook 会结束后续 beforeTool 检查；第一个明确停止任务的 afterTurn 也会结束后续 afterTurn 检查。

### 2.1 事件对应的状态顺序

从本章开始，Loop 不再直接 `messages.push()`。它交出完整消息，Agent 负责保存：

```text
Loop 产生 message_end
  → Agent 把消息放入自己的 messages
  → Agent 按订阅顺序 await 每个 listener
  → 全部成功后，Loop 才继续
```

否则，如果 Loop 和 Agent 都 push，同一条消息就会保存两次。后续 Step 4 的会话保存放在 listener 中，因此这里必须真正 `await`，不能只启动一个无人等待的 Promise。

### 2.2 与 pi 的关系

- [pi Agent.subscribe / processEvents](/Users/jquery/python_files/pi/packages/agent/src/agent.ts)：先更新 Agent 状态，再等待订阅者。
- [pi 工具调用处理](/Users/jquery/python_files/pi/packages/agent/src/agent-loop.ts)：参数准备、工具前后回调、工具结果和消息事件。

本章保留这些职责，使用更小的事件类型和 Hook 返回值。事件名和详细顺序是 Alpha 自己的教学约定，尤其是本章先提交 ToolMessage，再发出 `tool_end`。

## 3. 本章文件与阅读顺序

```text
src/
├─ hooks.ts          # 新增：Hook 契约、消息复制
├─ events.ts         # 新增：事件和运行结果类型
├─ tools.ts          # 替换：把参数准备与实际执行分开
├─ dispatch.ts       # 替换：接入工具前后 Hook
├─ agent-loop.ts     # 替换：接入模型与轮次 Hook，发送事件
├─ agent.ts          # 替换：保存消息、订阅与异步通知
├─ app.ts            # 替换：连接示例 Hook
└─ cli.ts            # 替换：显示事件，区分回答与停止
```

先读 Hook 的输入和返回值，再看 Dispatch 如何消费返回值，最后看 Loop 和 Agent 如何传递事件。下面八段带 `file:` 标记的代码都是完整文件；其他短片段只用于解释。

## 4. src/hooks.ts：普通对象与可选回调

<!-- file: src/hooks.ts -->
```ts
import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from "@langchain/core/messages";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";

export type MaybePromise<T> = T | Promise<T>;
export type ToolStatus = "success" | "error" | "denied";

export type ToolHookCall = {
  id: string;
  name: string;
  args: unknown;
  cwd: string;
};

export type ToolHookResult = {
  id: string;
  name: string;
  status: ToolStatus;
  raw: string;
  content: string;
};

export type TurnInfo = {
  turn: number;
  toolCount: number;
  hasAnswer: boolean;
};

export type Hook = {
  beforeModel?: (
    messages: BaseMessage[],
    signal: AbortSignal,
  ) => MaybePromise<BaseMessage[] | void>;
  afterModel?: (
    response: AIMessage,
    signal: AbortSignal,
  ) => MaybePromise<void>;
  beforeTool?: (
    call: ToolHookCall,
    signal: AbortSignal,
  ) => MaybePromise<string | void>;
  afterTool?: (
    result: ToolHookResult,
    signal: AbortSignal,
  ) => MaybePromise<string | void>;
  afterTurn?: (
    turn: TurnInfo,
    signal: AbortSignal,
  ) => MaybePromise<string | void>;
};

export function copyMessages(messages: BaseMessage[]): BaseMessage[] {
  const stored = mapChatMessagesToStoredMessages(messages);
  const copied = structuredClone(stored);
  return mapStoredMessagesToChatMessages(copied);
}
```

### 4.1 `?`、`MaybePromise` 和 `void`

以这个字段为例：

```ts
beforeTool?: (call: ToolHookCall, signal: AbortSignal) => MaybePromise<string | void>;
```

- `beforeTool?`：这个属性可以不存在。只实现 afterTool 的对象也能作为 Hook。
- `(call, signal) => ...`：描述函数接收什么和返回什么，不是在这里执行函数。
- `string | void`：可以返回字符串，也可以不返回值。
- `MaybePromise<T>`：既可以直接返回 T，也可以返回一个以后得到 T 的 Promise。

因此以下两种回调都可以使用：

```ts
const syncHook: Hook = {
  beforeTool(call) {
    if (call.name === "bash") {
      return "本次不允许执行命令";
    }
  },
};

const asyncHook: Hook = {
  async beforeTool(call, signal) {
    signal.throwIfAborted();
    if (call.name === "bash") {
      return "本次不允许执行命令";
    }
  },
};
```

这两个对象仅用于说明写法，不需要一并注册。没有异步工作时优先写同步函数；调用方统一 `await`，两种返回方式都能处理。

本章约定 beforeTool、afterTurn 返回空白字符串也视为“不拒绝 / 不停止”。afterTool 的规则不同：返回任何字符串，包括空字符串，都表示用它替换当前正文。

### 4.2 参数已经校验，为什么 args 仍是 unknown

`unknown` 在这里表示“这个通用 Hook 尚不知道是哪一种工具参数”。Zod 已经检查了当前工具的 schema，但同一个回调还可能接收 read、edit 或 bash，TS 不能只凭 `name: string` 推导 args 的字段。

本章示例只按工具名作决策，不需要读取 args。以后写路径策略时，可以用 `typeof`、`in` 等缩小到所需字段，再作路径判断，不必在每个 Hook 重复解析整个工具 schema。

### 4.3 为什么不能只复制数组

`[...messages]` 只复制数组，里面的消息对象还是原来的对象。Hook 若修改某条消息的 content，仍可能改到 Agent 的历史。

`copyMessages()` 分三步做：

```text
LangChain 消息实例
  → mapChatMessagesToStoredMessages：提取可表示的消息数据
  → structuredClone：复制这些数据及嵌套字段
  → mapStoredMessagesToChatMessages：恢复消息实例
```

不能直接把 `structuredClone(messages)` 当成 `BaseMessage[]`：普通深复制不会替你保留自定义类的全部原型行为。恢复之后仍是 AIMessage、ToolMessage 等实例，原来的 `instanceof` 检查可以继续使用。

这里仅用于内存中的消息副本，没有保存文件，也没有实现 Session。范围仍是前两章的标准文本消息和可复制元数据；把函数等不可复制值放进元数据会失败。

## 5. src/events.ts：用 type 区分事件

<!-- file: src/events.ts -->
```ts
import type { BaseMessage } from "@langchain/core/messages";
import type { ToolStatus } from "./hooks.ts";

export type RunResult =
  | { status: "completed"; answer: string; turns: number }
  | { status: "stopped"; reason: string; turns: number };

export type AgentEndEvent = {
  type: "agent_end";
  status: "completed" | "stopped" | "aborted" | "error";
  detail: string;
};

export type AgentEvent =
  | { type: "message_end"; message: BaseMessage }
  | { type: "tool_start"; callId: string; name: string }
  | {
      type: "tool_end";
      callId: string;
      name: string;
      status: ToolStatus;
      raw: string;
      content: string;
    }
  | { type: "turn_end"; turn: number; toolCount: number; hasAnswer: boolean }
  | AgentEndEvent;

export type EventListener = (event: AgentEvent) => void | Promise<void>;
export type EmitEvent = (event: AgentEvent) => Promise<void>;
```

`AgentEvent` 是一个联合类型：事件对象必须符合其中一种形状。`type` 的固定字符串帮助 TS 识别是哪一种：

```ts
if (event.type === "tool_end") {
  console.log(event.name, event.status);
}
```

进入这个分支后才允许按工具结束事件读取字段。`message_end` 则有 message，不要求同时有 name 或 status。

`RunResult` 同样把正常回答和策略停止分开。本章开始，`agent.prompt()` 返回 `Promise<RunResult>`，不再只返回字符串；CLI 会同步调整，避免把停止原因当成模型已经完成的答案。

`tool_end.raw` 是工具处理阶段的原始结果文本，`content` 是最终放进 ToolMessage 的正文。afterTool 可以改正文，不能改变 raw；原始结果仍可能是工具自身已经截断过的输出，不等于完整系统日志。

## 6. src/tools.ts：校验之后，先不要执行

Step 2 的 `tool.execute(raw, ...)` 把 parse 和真正执行放在一起。现在必须在两者之间插入 beforeTool。

把统一入口改为 `prepare(raw)`：它解析一次参数，返回已准备的调用。这个对象中的 execute 记住解析结果，之后被调用时才产生实际副作用。

<!-- file: src/tools.ts -->
```ts
import { z } from "zod";

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
```

以 write 为例：

```text
tool.prepare(call.args)
  → write schema.parse：得到有 path、content 的对象
  → 返回 { args: 副本, execute: 函数 }
  → 此时没有写文件

beforeTool 检查 args 的副本
  → 允许后调用 prepared.execute(cwd, signal)
  → 闭包中的原始已校验 args 传给 write.ts
  → 真正写文件
```

准备对象暴露的是参数副本，具体执行函数使用闭包中的校验结果。Hook 即使误改了自己收到的参数，也不会改变真正执行的参数。

四个工具仍然调用 `defineTool({ name, description, schema, execute })`，传入格式不变，所以它们的文件沿用 Step 2。变化的是 defineTool 返回给调度器的统一入口。

这不是增加第二次 parse：原来 execute 中的 parse 移到了 prepare，后面执行时不再 parse。

## 7. src/dispatch.ts：直接调用工具前后 Hook

<!-- file: src/dispatch.ts -->
```ts
import { ToolMessage } from "@langchain/core/messages";
import type { Hook, ToolStatus } from "./hooks.ts";
import { truncateOutput } from "./tools.ts";
import type { Tool, ToolCall } from "./tools.ts";

export type ToolExecution = {
  message: ToolMessage;
  status: ToolStatus;
  raw: string;
};

export async function executeTool(
  call: ToolCall,
  tools: readonly Tool[],
  hooks: readonly Hook[],
  cwd: string,
  signal: AbortSignal,
): Promise<ToolExecution> {
  let status: ToolStatus = "success";
  let raw = "";

  try {
    signal.throwIfAborted();
    const tool = tools.find((item) => item.name === call.name);
    if (tool === undefined) {
      throw new Error(`未知工具：${call.name}`);
    }
    const prepared = tool.prepare(call.args);

    for (const hook of hooks) {
      const reason = await hook.beforeTool?.({
        id: call.id,
        name: call.name,
        args: structuredClone(prepared.args),
        cwd: cwd,
      }, signal);
      signal.throwIfAborted();

      if (typeof reason === "string" && reason.trim() !== "") {
        status = "denied";
        raw = `工具被拒绝：${reason}`;
        break;
      }
    }

    if (status !== "denied") {
      raw = await prepared.execute(cwd, signal);
    }
  } catch (error: unknown) {
    status = "error";
    const detail = error instanceof Error ? error.message : String(error);
    raw = `工具调用未成功：${detail}`;
  }

  let content = raw;
  for (const hook of hooks) {
    try {
      const replacement = await hook.afterTool?.({
        id: call.id,
        name: call.name,
        status: status,
        raw: raw,
        content: content,
      }, signal);
      if (typeof replacement === "string") {
        content = replacement;
      }
    } catch (error: unknown) {
      status = "error";
      const detail = error instanceof Error ? error.message : String(error);
      content = `工具结果处理失败：${detail}\n原始结果：\n${raw}`;
      break;
    }
  }

  if (status !== "success") {
    content = `[工具状态：${status}]\n${content}`;
  }
  const message = new ToolMessage({
    content: truncateOutput(content),
    tool_call_id: call.id,
    name: call.name,
    status: status === "success" ? "success" : "error",
  });
  return { message: message, status: status, raw: raw };
}
```

### 7.1 拆开理解可选调用

```ts
const reason = await hook.beforeTool?.(call, signal);
```

这里的 `?.(...)` 是“函数存在才调用”。可以先按下面的展开形式理解：

```ts
let reason: string | void = undefined;
if (hook.beforeTool !== undefined) {
  reason = await hook.beforeTool(call, signal);
}
```

Hook 没提供这个函数时，结果是 undefined，继续后面的流程。`await` 不代表并行：这里位于 for 循环中，当前 Hook 完成后才调用下一个。

### 7.2 raw 和 content 为什么分开

假设工具返回 10000 个代码单元，两个 afterTool 按顺序执行：

```text
raw：原始 10000 长度的字符串，一直保留
content：开始等于 raw
  → 第一个 Hook 返回较短正文
  → 第二个 Hook 看到较短的 content，以及不变的 raw
  → 最后做统一截断，构造 ToolMessage
```

Hook 只返回正文。调用 ID、工具名、状态由调度器填写，不能通过返回一个“新消息对象”把失败改成成功或换掉对应关系。

LangChain 的 ToolMessage 状态使用 success / error；Alpha 额外区分 denied，用于事件和本地观察。denied 放进 ToolMessage 时映射为 error，正文也标明拒绝。

### 7.3 失败路径

- 未知工具、schema 校验失败：没有可用的已校验参数，因此不调用 beforeTool，直接形成错误结果。
- beforeTool 返回拒绝原因：status 为 denied，不执行工具。
- beforeTool 抛异常或工具执行失败：status 为 error。
- 上述结果都会进入 afterTool；afterTool 抛异常时，标为 error，保留 raw，并停止剩余 afterTool。

工具后处理失败不意味着文件没有改动：真正的工具可能已经成功执行。事件中的 raw 和最终状态用于区分这两件事。

这里没有事件通知代码，所以之后的会话保存异常不会被这个 catch 转成普通工具失败。

## 8. src/agent-loop.ts：在原有主线上插入回调

<!-- file: src/agent-loop.ts -->
```ts
import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { executeTool } from "./dispatch.ts";
import type { EmitEvent, RunResult } from "./events.ts";
import { copyMessages } from "./hooks.ts";
import type { Hook, TurnInfo } from "./hooks.ts";
import type { ModelIO } from "./model-io.ts";
import { responseCalls, validateHistory } from "./protocol.ts";
import type { Tool } from "./tools.ts";

export async function runLoop(
  messages: BaseMessage[],
  model: ModelIO,
  tools: readonly Tool[],
  hooks: readonly Hook[],
  cwd: string,
  maxTurns: number,
  signal: AbortSignal,
  emit: EmitEvent,
): Promise<RunResult> {
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    signal.throwIfAborted();
    let requestMessages = copyMessages(messages);

    for (const hook of hooks) {
      const replacement = await hook.beforeModel?.(requestMessages, signal);
      if (replacement !== undefined) {
        requestMessages = replacement;
      }
    }
    signal.throwIfAborted();
    validateHistory(requestMessages);

    const response = await model.request(requestMessages, signal);
    signal.throwIfAborted();
    const calls = responseCalls(response);

    for (const hook of hooks) {
      if (hook.afterModel !== undefined) {
        const snapshot = copyMessages([response])[0];
        if (!(snapshot instanceof AIMessage)) {
          throw new Error("模型消息副本没有恢复为 AIMessage");
        }
        await hook.afterModel(snapshot, signal);
      }
    }
    signal.throwIfAborted();
    await emit({ type: "message_end", message: response });

    for (const call of calls) {
      await emit({ type: "tool_start", callId: call.id, name: call.name });
      const execution = await executeTool(call, tools, hooks, cwd, signal);
      await emit({ type: "message_end", message: execution.message });
      await emit({
        type: "tool_end",
        callId: call.id,
        name: call.name,
        status: execution.status,
        raw: execution.raw,
        content: execution.message.text,
      });
    }

    const info: TurnInfo = {
      turn: turn,
      toolCount: calls.length,
      hasAnswer: calls.length === 0,
    };
    await emit({ type: "turn_end", ...info });
    signal.throwIfAborted();

    for (const hook of hooks) {
      const reason = await hook.afterTurn?.({ ...info }, signal);
      signal.throwIfAborted();
      if (typeof reason === "string" && reason.trim() !== "") {
        return { status: "stopped", reason: reason, turns: turn };
      }
    }

    if (calls.length === 0) {
      return { status: "completed", answer: response.text, turns: turn };
    }
  }

  throw new Error(`已达到 ${maxTurns} 次模型请求的上限，本次任务尚未得到最终回答`);
}
```

### 8.1 beforeModel 修改哪一份消息

每轮先复制 Agent 当前历史，再依次交给 beforeModel。Hook 可以修改这个副本，也可以返回新数组；下一个 Hook 接着处理上一个结果。

最终只在请求边界调用一次 `validateHistory(requestMessages)`。不能让 Hook 删除了 AI 的工具调用，却留下对应 ToolMessage 后直接发送。

这些临时修改不写回 Agent 的历史。下一轮重新从历史生成副本；如果每轮都需要额外说明，就让 Hook 每轮添加一次。Step 5 才进一步讨论完整的 Context 构造。

### 8.2 afterModel 为什么在提交消息之前

先运行 `responseCalls()`，确认响应可用，再给观察 Hook 一份完整副本。如果 Hook 意外改写副本，不会改到本轮真正执行的调用。Hook 抛异常时，本次任务停止，此时还没有把含待执行调用的响应放进历史。

`copyMessages()` 的返回类型是 BaseMessage[]，所以在使用具体 AIMessage 回调前用 instanceof 缩小类型。这是副本类型检查，不是重新解析整个响应或历史。

### 8.3 为什么工具之间没有直接 throwIfAborted

模型一次提出两个工具调用，历史中就需要两个结果。取消发生在第一个工具中间时，调度器仍为当前和后续调用生成对应结果，后续工具的实际执行会被 signal 检查阻止。

整批结果提交后，Loop 才抛出取消异常。因而正常的取消不会留下“一条 AI 请求了两个工具，却只有一个结果”的历史。

这个约定依赖本章工具和 Hook 正确结束等待。signal 是协作式取消，不能强行中断任意自定义异步回调；bash 的进程树限制也继续沿用 Step 2。

### 8.4 轮次结束以后再决定继续

一轮包括一次模型请求及它提出的整批工具调用。这里先发出 turn_end，随后调用 afterTurn，因此事件说明“本轮处理结束”，并不说明下一轮一定会发生。

afterTurn 可以返回停止原因；如果没有停止，且没有工具调用，就返回 completed。自定义 Hook 即使在最终回答轮返回停止原因，也会优先得到 stopped；本章示例只在有工具的轮次后停止。

`completed` 表示得到了一条有效的最终回答，不表示模型一定完成了用户所有业务要求。例如只读模式拒绝写入后，模型解释无法完成，也可以正常结束回答。

## 9. src/agent.ts：更新消息，再等待订阅者

<!-- file: src/agent.ts -->
```ts
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { runLoop } from "./agent-loop.ts";
import type { AgentEndEvent, AgentEvent, EventListener, RunResult } from "./events.ts";
import { copyMessages } from "./hooks.ts";
import type { Hook } from "./hooks.ts";
import type { ModelIO } from "./model-io.ts";
import type { Tool } from "./tools.ts";

export class Agent {
  private messages: BaseMessage[];
  private model: ModelIO;
  private tools: readonly Tool[];
  private hooks: readonly Hook[];
  private cwd: string;
  private maxTurns: number;
  private controller: AbortController | undefined;
  private listeners: Set<EventListener>;
  private deliveryFailed: boolean;

  constructor(
    model: ModelIO,
    tools: readonly Tool[],
    cwd: string,
    hooks: readonly Hook[] = [],
    maxTurns: number = 8,
  ) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new Error("maxTurns 必须是正整数");
    }

    this.model = model;
    this.tools = [...tools];
    this.hooks = [...hooks];
    this.cwd = cwd;
    this.maxTurns = maxTurns;
    this.controller = undefined;
    this.listeners = new Set<EventListener>();
    this.deliveryFailed = false;
    this.messages = [
      new SystemMessage(
        "你是 Alpha，一个模仿 pi1 的 coding agent demo。" +
        "你可以使用 read、write、edit、bash。涉及文件内容时先读取，不要猜测。" +
        "write 用于创建或完整覆盖；局部修改先 read 再 edit。" +
        "只执行用户任务所需的操作，修改完成后读取文件或运行合适命令核对。" +
        "bash 只运行短时非交互命令，不启动后台服务。" +
        "工具被策略拒绝时不要绕过限制，说明无法完成的部分。" +
        "最终回答区分已经完成与尚未验证的内容。",
      ),
    ];
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async emit(event: AgentEvent): Promise<void> {
    if (event.type === "message_end") {
      this.messages.push(event.message);
    }

    try {
      for (const listener of [...this.listeners]) {
        let notification: AgentEvent = { ...event };
        if (event.type === "message_end") {
          notification = {
            type: "message_end",
            message: copyMessages([event.message])[0],
          };
        }
        await listener(notification);
      }
    } catch (error: unknown) {
      this.deliveryFailed = true;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`事件通知失败：${detail}`, { cause: error });
    }
  }

  async prompt(input: string): Promise<RunResult> {
    if (this.controller !== undefined) {
      throw new Error("Agent 正在运行，请等待结束后再提交输入");
    }
    if (this.deliveryFailed) {
      throw new Error("之前的事件通知失败，状态可能未保存完整，请新建 Agent 后重试");
    }
    if (input.trim() === "") {
      throw new Error("用户输入不能为空");
    }

    const controller = new AbortController();
    this.controller = controller;
    let ending: AgentEndEvent = {
      type: "agent_end",
      status: "error",
      detail: "本次运行未正常结束",
    };

    try {
      await this.emit({ type: "message_end", message: new HumanMessage(input) });
      const result = await runLoop(
        this.messages,
        this.model,
        this.tools,
        this.hooks,
        this.cwd,
        this.maxTurns,
        controller.signal,
        (event) => this.emit(event),
      );
      ending = {
        type: "agent_end",
        status: result.status,
        detail: result.status === "completed" ? "已得到最终回答" : result.reason,
      };
      return result;
    } catch (error: unknown) {
      ending = {
        type: "agent_end",
        status: controller.signal.aborted ? "aborted" : "error",
        detail: error instanceof Error ? error.message : String(error),
      };
      throw error;
    } finally {
      try {
        if (!this.deliveryFailed) {
          await this.emit(ending);
        }
      } finally {
        this.controller = undefined;
      }
    }
  }

  abort(): void {
    this.controller?.abort();
  }
}
```

### 9.1 subscribe 返回的是什么

```ts
const unsubscribe = agent.subscribe(listener);
```

调用 subscribe 时把 listener 放进集合，返回一个函数。以后调用 `unsubscribe()`，才把这个 listener 从集合移除。这也是闭包：返回的函数记住了当前 Agent 和传入的 listener。

`Set<EventListener>` 保存函数，不会把同一个函数引用重复登记。通知前用 `[...this.listeners]` 取得本次事件的订阅者快照；通知过程中增删订阅，从下一次事件起生效。

### 9.2 emit 同时负责哪两件事

先保存 message_end，再按顺序等待 listener。每个 listener 得到独立的事件对象；消息事件还会复制消息，避免观察者修改 Agent 历史或影响下一位观察者。

工具结果事件只含字符串，复制顶层对象就够了。raw 不默认打印到终端，也没有在本章持久化。

传给 Loop 的 `(event) => this.emit(event)` 保留了 Agent 的 this。直接把 `this.emit` 当函数传出去，调用时可能丢失方法原本的 this。

### 9.3 事件通知失败为什么要停止

假设第一个 listener 将来负责写 JSONL，第二个负责显示。如果保存失败，继续执行下一个工具可能让磁盘历史落后于实际副作用。

因此 listener 抛异常就向上失败，不会被当作模型可以修正的普通工具错误。此时内存中的消息可能已追加，一部分 listener 也可能已完成；本章不尝试回滚，标记 deliveryFailed，并要求使用新 Agent。不能通过取消订阅就假装之前的保存已经完成。

通知失败后不会继续发送 agent_end；连结束通知也可能失败。CLI 最外层的异常处理仍会报告错误。**不能以“没收到失败事件”推断成功。**

### 9.4 finally 为什么有两层

外层 finally 尝试等待 agent_end 的订阅者。内层 finally 保证即使结束通知失败，也清理 controller。

在 agent_end 回调全部完成前，Agent 仍处于运行中。listener 不要等待当前 prompt 自己完成，也不要在其中启动同一个 Agent 的新任务；前者会互相等待，后者会被运行中检查拒绝。

如果业务错误之后，结束通知又失败，最终抛出的是通知错误，不能认为运行已正常收尾。completed / stopped 也只有在结束通知成功后才会返回给 prompt 的调用者。

构造函数里的 SystemMessage 是启动配置，不触发 message_end。后续 Session 需要单独记录配置；本章事件记录并不是可直接恢复的完整会话文件。

## 10. src/app.ts：注册一组可观察的 Hook

默认模式保留四个工具；使用两个环境变量演示拒绝和停止。新增逻辑不需要修改 `.env`，也可以只对某条启动命令设置变量。

<!-- file: src/app.ts -->
```ts
import { SystemMessage } from "@langchain/core/messages";
import { Agent } from "./agent.ts";
import { bashTool } from "./builtin-tools/bash.ts";
import { editTool } from "./builtin-tools/edit.ts";
import { readTool } from "./builtin-tools/read.ts";
import { writeTool } from "./builtin-tools/write.ts";
import type { Hook } from "./hooks.ts";
import { createModelIO } from "./model-io.ts";
import { truncateOutput } from "./tools.ts";
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

  const model = createModelIO(modelName, apiKey, tools, baseURL);
  return new Agent(model, tools, cwd, hooks, 8);
}
```

这里的一组 Hook 对象演示了五个位置：

1. beforeModel 在原系统消息之后加入本轮只读说明。
2. afterModel 读取服务返回的 token 用量；没有 usage 时不猜测数值。
3. beforeTool 真正拒绝本次不允许的调用。
4. afterTool 缩短模型看到的正文，同时保留 raw。
5. afterTurn 在完整工具轮结束后，按配置停止。

模型声明仍包含四个工具，便于观察“声明了工具，但本次调用被策略拒绝”的区别。beforeModel 的文字说明影响模型选择，beforeTool 才是本地调用检查。

本例的 usage 输出只是观察 Hook 的演示。工具进度由下面的事件订阅显示，不放进各个工具函数。

## 11. src/cli.ts：订阅事件，处理两种返回结果

<!-- file: src/cli.ts -->
```ts
import { createAgent } from "./app.ts";
import type { AgentEvent } from "./events.ts";

function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case "message_end":
      console.error(`[message_end] ${event.message.type}`);
      break;
    case "tool_start":
      console.error(`[tool_start] ${event.name} ${event.callId}`);
      break;
    case "tool_end":
      console.error(`[tool_end] ${event.name} ${event.status}`);
      break;
    case "turn_end":
      console.error(`[turn_end] 第 ${event.turn} 轮，${event.toolCount} 次工具调用`);
      break;
    case "agent_end":
      console.error(`[agent_end] ${event.status}：${event.detail}`);
      break;
  }
}

async function main(): Promise<void> {
  const input = process.argv.slice(2).join(" ").trim();
  if (input === "") {
    console.log('用法：npm start -- "读取 package.json，说明项目依赖"');
    return;
  }

  const agent = createAgent(process.cwd());
  const unsubscribe = agent.subscribe(printEvent);
  let interrupted = false;

  function onInterrupt(): void {
    interrupted = true;
    agent.abort();
  }

  process.on("SIGINT", onInterrupt);
  try {
    const result = await agent.prompt(input);
    if (result.status === "completed") {
      console.log(result.answer);
    } else {
      console.error(`本次任务按策略停止：${result.reason}`);
      process.exitCode = 2;
    }
  } catch (error: unknown) {
    if (interrupted) {
      console.error("收到取消请求，本次任务未正常完成");
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 130;
    } else {
      throw error;
    }
  } finally {
    unsubscribe();
    process.off("SIGINT", onInterrupt);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

进度使用 stderr，最终回答使用 stdout。退出码约定：正常回答为 0，策略停止为 2，普通失败为 1，收到 Ctrl+C 后失败退出为 130。

收到取消请求同时也可能出现其他错误，因此取消分支仍打印实际异常，不把事件保存失败等问题藏掉。

`printEvent` 作为函数值传给 subscribe。事件到来时 Agent 才调用它，不是在注册那一刻执行。

## 12. 把一次拒绝串起来看

假设开启只读模式，模型仍返回一次 write 调用：

```text
CLI：agent.prompt(input)
  → Agent 提交 HumanMessage，等待 message_end 订阅者
  → Loop 复制历史，调用 beforeModel
  → 检查本轮请求历史，调用模型
  → responseCalls 检查响应
  → afterModel 观察响应副本
  → Agent 提交 AIMessage，等待订阅者
  → tool_start(write)
  → Dispatch 找 write，prepare 解析参数
  → beforeTool 返回“本次只读”
  → 跳过 prepared.execute，status = denied
  → afterTool 处理拒绝正文，raw 保留
  → Agent 提交 ToolMessage，等待订阅者
  → tool_end(write, denied)
  → turn_end
  → afterTurn 未要求停止
  → 下一轮模型看到拒绝结果
  → 模型解释限制，不再请求工具
  → 提交 AIMessage，turn_end，agent_end(completed)
  → CLI 输出最终说明
```

如果在第一轮 afterTurn 返回原因，最后几步改为 `RunResult.status = stopped → agent_end(stopped) → CLI 显示停止原因`，不会再请求模型生成最终回答。

若某次 message_end 订阅者失败，流程直接抛出错误，后面的工具和事件不继续。这与工具被拒绝后仍能下一轮解释原因是不同路径。

## 13. 运行与人工核对

### 13.1 先确认八份文件接好了

将本章八份代码保存后，在 alpha 根目录运行：

```sh
cd /Users/jquery/ts_files/alpha
npm run check
npm start
```

类型检查不请求模型；无参数启动只显示用法。常见接线问题：

| 提示 | 核对位置 |
| --- | --- |
| Tool 上不存在 execute | Dispatch 应先 `prepare()`，再调用准备对象的 execute |
| 工具结果上不存在 content | executeTool 现在返回 ToolExecution，消息在 `.message` |
| prompt 返回值不是字符串 | CLI 应按 result.status 读取 answer 或 reason |
| 构造参数类型不匹配 | Agent 的第 4 个参数现在是 hooks，第 5 个才是 maxTurns |

### 13.2 正常读取，观察事件顺序

```sh
npm start -- "请调用 read 读取 package.json，然后解释 dependencies。"
```

确认出现 `tool_start read → message_end tool → tool_end read success → turn_end`，之后再有模型回答。真实 ID 由模型服务提供，不要求等于文档示例。

出现 `[usage]` 说明服务提供了用量字段，不能用它判断文件是否读过；以工具事件和内容核对为准。

### 13.3 只读模式

```sh
ALPHA_READ_ONLY=1 npm start -- "在 .alpha/practice/hook-note.txt 写入 hello；如果本次策略不允许，就解释限制。"
```

模型可能看到只读说明就直接回答，没有提出 write。这说明模型遵从了提示，**没有验证本地拒绝分支**。

若实际出现 write / edit / bash 调用，应该观察到 denied，不能执行该工具；若想查看本地分支，可以在 beforeTool 和 prepared.execute 处设断点。需要确定性验收时，应独立调用调度器或使用明确指定响应的模型替身；本章不新增这些测试文件或脚手架。

只读模式仍允许 read。可另运行读取 package.json 的任务，核对它正常返回 success。

### 13.4 在完整工具轮后停止

```sh
ALPHA_STOP_AFTER_TURN=1 npm start -- "请先调用 read 读取 package.json，再根据实际内容回答。"
```

如果模型确实请求了 read，工具结果提交后应出现 `turn_end → agent_end stopped`，CLI 退出码为 2，不发起用于总结的下一次模型请求。

如果模型没有调用工具而直接回答，本例不会强行停止，返回 completed。最终回答是否真的基于文件内容，仍需要看实际调用证据。

### 13.5 结果改写、异常与取消

| 情况 | 核对什么 |
| --- | --- |
| read 返回超过 8000 个代码单元的文本 | 在 tool_end 断点比较 raw 与 content；正文缩短，raw 保留 |
| 工具参数错误或文件不存在 | tool_end 为 error，ToolMessage 仍带原调用 ID |
| afterTool 处理失败 | 原始工具可能已经执行，raw 不变，最终消息标记 error |
| 订阅者失败 | prompt 抛错，不继续后续工具，不保证还有 agent_end |
| 工具执行期间 Ctrl+C | 为已接收整批调用收集结果，再停止；已完成写入不回滚 |

普通事件不会自动持久化，看到日志不表示会话已保存。订阅者失败后的状态恢复、跨进程加载都留到后续章节，不在这里声称已经支持。

这些模型任务会使用已有 `.env` 配置并产生真实请求。类型检查、无参数 CLI 启动与上述运行行为分别记录，不混作一次端到端验证。

## 14. 学完后应该能解释

1. beforeTool 返回字符串以后，是哪一行代码决定不执行工具？
2. beforeTool 接收的参数在哪里检查？为什么本章没有重复 parse？
3. prepare 返回的 execute 怎样记住已经解析的参数？
4. 同步 Hook 为什么也能被 await？可选回调不存在时发生什么？
5. afterTool 为什么只能返回正文，不能返回新 ToolMessage？
6. raw、content 和 ToolMessage 分别由谁保存、谁使用？
7. 为什么 beforeModel 修改的内容不会累积到 Agent 的原始历史？
8. 为什么必须由 Agent 统一保存 message_end，不能 Loop 和 Agent 各保存一次？
9. 为什么事件订阅者失败不能变成普通工具错误？
10. 为什么 agent_end 的回调完成前，Agent 还不能接收下一次 prompt？

下一步加入 AgentSession 和 SessionManager：把消息事件接到 JSONL 保存，并在新进程中恢复消息实例。本章的异步通知已经提供接入点，但尚未实现会话保存。

## 15. API 依据与验证范围

消息转换函数和字段已核对 alpha 安装的 `@langchain/core` 声明及实现。事件联合类型的收窄方式参考 [TypeScript 官方手册](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions)。`structuredClone` 只用于可复制数据，随后由 LangChain 恢复消息类实例。

2026-10-19 的验证结果：

- 在独立临时目录按 Step 1 → Step 2 → Step 3 顺序提取完整文件代码块，分别为 11、10、8 个；后一章覆盖前一章同名文件，得到本章完整项目。
- 复用 alpha 已安装的依赖，运行 `npm run check` 通过，无类型错误；未新增依赖，未验证一次全新安装。
- 无参数运行 `npm start`，正确打印用法，退出码为 0。
- 临时目录没有 `.env`，移除进程中的模型配置后带任务参数启动，正确提示缺少 `OPENAI_API_KEY`，退出码为 1，没有请求模型。
- 文档中的本地文件链接均存在。本次只新增 `steps/step3.md`，未覆盖 alpha 的实际练习源码，未新增或修改测试文件。
- 未执行真实模型调用、Hook 拒绝与停止分支、订阅者失败、取消或工具副作用验收；以上静态与启动检查不能替代第 13 节的运行行为验证。
