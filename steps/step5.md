# Step 5：构造 Context，区分会话历史与本轮模型输入

[项目总览](summary.md) · [上一步：Session 保存与加载](step4.md)

这一章接着 Step 4，给出 **5 个新增或替换文件的完整内容**。Session 文件格式、消息 codec、Hook、事件、工具和 CLI 沿用前四章，不新增依赖。本文件是教程；按路径保存代码后，功能才会接入练习项目。

本章完成路线图中的“系统提示 + 有效会话消息”，并让你分别查看保存的历史和提交给模型适配器的消息。摘要、Token 预算和旧消息裁剪留到 Step 6。

## 1. 为什么保存了 Session，还需要 Context

Step 4 已经能把历史保存下来。Step 3 的 beforeModel 又能给一次请求加入临时说明。这时已经有两份含义不同的数据：

```text
保存的历史：
  SystemMessage：Alpha 的长期工作说明
  HumanMessage：读取 package.json
  AIMessage：调用 read，id = call_1
  ToolMessage：文件内容，tool_call_id = call_1

当前开启 ALPHA_READ_ONLY=1，下一次请求：
  SystemMessage：Alpha 的长期工作说明
  SystemMessage：本次只读，只允许 read
  HumanMessage：读取 package.json
  AIMessage：调用 read，id = call_1
  ToolMessage：文件内容，tool_call_id = call_1
```

临时只读说明来自 beforeModel，没有对应的 message_end，因此不会成为会话中的独立消息记录。下一轮仍应从保存的历史重新构造，避免每轮在上轮请求上继续叠加说明。模型的回答可能提到只读限制，那段回答仍会正常保存。

到了 Step 6，区别会更明显：历史保留旧消息，请求使用摘要与近期消息。现在先把“消息从哪里来”和“每轮在哪里准备”接清楚。

### 1.1 本章改变哪一行调用

Step 4 的 Loop 每轮直接复制 Agent 数组：

```ts
let requestMessages = copyMessages(messages);
```

本章改为调用一个由上层提供的函数：

```ts
let requestMessages = await prepareContext(signal);
```

这个函数在 AgentSession 中创建，真正执行时才读取 Manager 的最新消息。Loop 只知道它返回 `BaseMessage[]`，不需要认识会话文件、记录 ID 或 JSONL。

**传入的是函数，不是提前算好的数组。** 如果在 prompt 开始时只构造一次，后面 read 产生的 ToolMessage 就不会出现在第二次请求中。

## 2. 四份数据与三个处理位置

| 数据 | 谁持有或生成 | 本章中的用途 |
| --- | --- | --- |
| JSONL 文件 | SessionManager 写入和加载 | 跨进程保存会话记录 |
| Manager.entries | SessionManager | 已成功保存的记录在内存中的表示；getMessages 解码它们 |
| Agent.messages | Agent | 当前运行接纳的消息；继续承担状态更新和加载 |
| requestMessages | 每轮 prepareContext + beforeModel | 本次交给 model.request 的消息副本 |

正常写入完成后，Manager 和 Agent 保存的消息内容相对应；保存失败时二者可能不一致，所以 Step 4 的 deliveryFailed 仍然禁止继续运行。不要在这种情况下退回使用 Agent 数组来绕过保存错误。

`getMessages()` 不会每轮重新打开磁盘文件。新建或加载时建立 entries，之后 appendMessage 写入成功才追加 entries；本章从这份记录快照构造上下文。沿用 Step 4 的单进程写入约定，不检测外部程序对会话文件的改动。

| 位置 | 做什么 | 返回值给谁 |
| --- | --- | --- |
| AgentSession 的 prepareContext 回调 | 取得最新已保存消息，调用 buildContext | 返回给正在等待的 Loop |
| context.ts 的 buildContext | 复制消息，检查系统提示与工具配对，返回基础上下文 | 返回给回调 |
| beforeModel | 调整本轮临时消息，随后再次检查配对 | 最终交给 model.request |

Context 没有独立的状态，因此用普通函数即可。这里只增加一个明确的回调，不建立 Context 类、注册表或新的 Runtime。

### 2.1 与本地 pi 的对应关系

本地 pi 的 [SessionManager](/Users/jquery/python_files/pi/packages/coding-agent/src/core/session-manager.ts) 通过 buildSessionProjection / buildSessionContext 从会话记录构造模型上下文；[agent-loop.ts](/Users/jquery/python_files/pi/packages/agent/src/agent-loop.ts) 在模型调用边界等待 transformContext，再调用 convertToLlm。

Alpha 保留“会话记录 → 本轮上下文 → 请求前调整 → 模型”的分工。Alpha 已经使用 LangChain 的消息实例，不需要再建立一套 convertToLlm 消息类型转换层。本章的 prepareContext 是教学接口，不声称与 pi 的接口或每轮重建方式完全相同。

## 3. 文件与阅读顺序

```text
src/
├─ context.ts           # 新增：从历史构造基础上下文
├─ agent-loop.ts        # 替换：每轮 await prepareContext
├─ agent.ts             # 替换：把回调传给 Loop
├─ agent-session.ts     # 替换：提供从 Manager 取消息的回调
└─ model-io.ts          # 替换：可选打印最终请求消息
```

下面五段带 `file:` 标记的代码都是完整文件。app.ts、cli.ts 必须已经采用 Step 4 的 createSession 版本，其余文件按前四章的最新版本保留。

Agent.prompt 现在要求第二个参数 prepareContext；对外的 session.prompt(input) 不变。若你还有自己写的直接 agent.prompt 调用，需要同步传入上下文准备函数。本章不另做一套旧签名兼容分支。

## 4. src/context.ts：先把最简单的规则写清楚

Step 4 的 Manager.getMessages 已经去掉记录外壳，返回恢复类型后的消息数组。因此 buildContext 的输入不是 JSONL 字符串，也不是含 timestamp、记录 ID 的 MessageEntry 数组。

当前规则很简单：保留会话中已有的系统提示和全部对话消息，保持原顺序。没有摘要记录，也没有需要跳过的特殊记录。

<!-- file: src/context.ts -->
```ts
import { SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { copyMessages } from "./hooks.ts";
import { validateHistory } from "./protocol.ts";

export function buildContext(history: BaseMessage[]): BaseMessage[] {
  const messages = copyMessages(history);
  if (!(messages[0] instanceof SystemMessage)) {
    throw new Error("上下文必须以会话的 SystemMessage 开始");
  }
  validateHistory(messages);
  return messages;
}
```

### 4.1 为什么没有再 new SystemMessage

系统提示已经由 Step 4 的 SessionManager.create 保存，加载时也会恢复。这里检查第一条消息的类型后直接保留它，避免每轮添加一条重复提示，也避免恢复旧会话时悄悄替换它的历史系统提示。

`messages[0]` 在空数组上是 undefined，instanceof 检查不会通过，所以空历史也会明确报错。这个检查只要求首条为 SystemMessage，不强制整个数组只能有一条系统消息。

### 4.2 为什么要 copyMessages

如果直接返回 history，后面的 Hook 原地修改某条消息时，会影响传给 buildContext 的那份输入。`[...history]` 只复制数组，里面的消息对象仍是同一个引用。

沿用 Step 3 的 copyMessages：

```text
LangChain 消息实例
  → mapChatMessagesToStoredMessages
  → structuredClone 普通消息数据
  → mapStoredMessagesToChatMessages
  → 新的消息实例
```

Manager.getMessages 本身也会返回新实例，所以当前调用链有两次复制。这是本章选择的简单边界：Manager 不暴露内部记录，buildContext 也不把调用者的消息交给 Hook 修改。它会增加复制开销；本章面向小规模文本会话，不把它当作大历史的性能方案。

### 4.3 为什么还要检查工具配对

例如原历史是：

```text
AIMessage：call_1 = read，call_2 = read
ToolMessage：对应 call_1
ToolMessage：对应 call_2
```

不能简单使用 slice(-1) 只留最后一条 ToolMessage，也不能保留 AIMessage 却删掉其中一个结果。buildContext 复用 protocol.ts 的 validateHistory，不另写一套 pending ID 算法。

本章完整保留历史，因此不会主动造成这种截断。这里检查基础上下文，Loop 在 beforeModel 后检查调整后的上下文；两处检查面对不同阶段的数据。配对检查只保证本项目约定的调用关系，不保证模型记得所有语义，也不检查上下文是否超过模型容量。

## 5. src/agent-loop.ts：每轮取得最新上下文

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

export type PrepareContext = (signal: AbortSignal) => Promise<BaseMessage[]>;

export async function runLoop(
  prepareContext: PrepareContext,
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
    let requestMessages = await prepareContext(signal);
    signal.throwIfAborted();

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

### 5.1 PrepareContext 是函数类型

```ts
export type PrepareContext = (signal: AbortSignal) => Promise<BaseMessage[]>;
```

从左到右读：这个函数接收一个取消信号，调用后返回 Promise；await 之后得到消息数组。type 只描述形状，不会创建函数，也不会自己读取 Session。

它放在 agent-loop.ts，因为 Loop 定义自己需要什么输入。Agent 和 AgentSession 提供实现；Loop 不导入 SessionManager 或 context.ts。

### 5.2 一轮的请求准备顺序

```text
检查是否已取消
  → await prepareContext(signal)
  → 再检查取消，避免异步准备结束后仍继续请求
  → 依次 await beforeModel
  → 检查取消
  → validateHistory(requestMessages)
  → model.request(requestMessages, signal)
```

prepareContext 或 beforeModel 抛错，就不会到达 model.request；异常仍沿 runLoop → Agent.prompt → CLI 传播。取消也沿用同一个 controller.signal，不额外创建一套取消机制。

每轮的 requestMessages 都是新得到的局部变量，不写回 Agent，也不通过 message_end 保存。模型响应和真实工具结果仍走原来的事件路径。

### 5.3 为什么必须在完整工具批次之后再构造

模型同时请求两个工具时，Loop 仍然串行执行并保存两个结果，之后才进入下一轮。不要在每个 tool_end 后单独请求模型：此时可能还欠同一条 AIMessage 中其他调用的结果。

本章只改变请求输入的来源。afterModel、工具 Hook、turn_end、afterTurn、最大轮数和取消时补齐当前批次结果的规则都沿用 Step 3。

## 6. src/agent.ts：保留状态，把准备函数交给 Loop

Agent 仍在 message_end 中更新 messages，再等待订阅者。它不再把 this.messages 直接作为 Loop 的输入，而是传递这次 prompt 收到的 prepareContext。

<!-- file: src/agent.ts -->
```ts
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { runLoop } from "./agent-loop.ts";
import type { PrepareContext } from "./agent-loop.ts";
import type { AgentEndEvent, AgentEvent, EventListener, RunResult } from "./events.ts";
import { copyMessages } from "./hooks.ts";
import type { Hook } from "./hooks.ts";
import type { ModelIO } from "./model-io.ts";
import type { Tool } from "./tools.ts";
import { responseCalls, validateHistory } from "./protocol.ts";

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

  getMessages(): BaseMessage[] {
    return copyMessages(this.messages);
  }

  replaceMessages(messages: BaseMessage[]): void {
    if (this.controller !== undefined || this.deliveryFailed) {
      throw new Error("只能为未运行且未发生通知失败的 Agent 装入历史");
    }
    const restored = copyMessages(messages);
    if (!(restored[0] instanceof SystemMessage)) {
      throw new Error("会话必须以 SystemMessage 开始");
    }
    // 加载历史也是输入边界，复用同一个 protocol.ts，不另写配对规则。
    for (const message of restored) {
      if (message instanceof AIMessage) {
        responseCalls(message);
      }
    }
    validateHistory(restored);
    this.messages = restored;
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

  async prompt(input: string, prepareContext: PrepareContext): Promise<RunResult> {
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
        prepareContext,
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

### 6.1 用户输入为什么一定出现在第一轮上下文中

关键是下面两步的先后：

```text
await emit(HumanMessage)
  → Agent.messages 加入输入
  → await Manager.appendMessage，成功后 entries 加入输入
  → 所有订阅者完成

await runLoop(prepareContext, ...)
  → 第一次调用 prepareContext
  → Manager.getMessages 此时已经包含这条 HumanMessage
```

如果在 emit 之前取得数组，第一轮就会漏掉新问题；如果只启动保存而不等待，也无法保证记录可见。本章保留 Step 4 的 await 保存顺序。

### 6.2 为什么 Agent.messages 仍然存在

Agent 仍负责当前运行状态；getMessages 用于新建会话，replaceMessages 用于加载历史，emit 用于接纳新消息。只是模型输入的选择现在交给上层提供的函数。

Step 5 尚未压缩，所以正常情况下 Agent 消息与已保存消息内容一致。不要为了制造区别而在这里删历史。Step 6 再决定摘要与近期消息怎样组成下一次请求。

## 7. src/agent-session.ts：在调用时读取 Manager

<!-- file: src/agent-session.ts -->
```ts
import type { Agent } from "./agent.ts";
import { buildContext } from "./context.ts";
import type { EventListener, RunResult } from "./events.ts";
import { SessionManager } from "./session-manager.ts";

export class AgentSession {
  private agent: Agent;
  private manager: SessionManager;

  private constructor(agent: Agent, manager: SessionManager) {
    this.agent = agent;
    this.manager = manager;
    this.agent.subscribe(async (event) => {
      if (event.type === "message_end") {
        await this.manager.appendMessage(event.message);
      }
    });
  }

  static async create(agent: Agent, cwd: string): Promise<AgentSession> {
    const manager = await SessionManager.create(cwd, agent.getMessages());
    return new AgentSession(agent, manager);
  }

  static async load(agent: Agent, cwd: string, filePath: string): Promise<AgentSession> {
    const manager = await SessionManager.load(filePath, cwd);
    try {
      agent.replaceMessages(manager.getMessages());
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`无法继续会话 ${manager.filePath}：${detail}。不会重放工具或删除记录`, {
        cause: error,
      });
    }
    return new AgentSession(agent, manager);
  }

  get filePath(): string {
    return this.manager.filePath;
  }

  get id(): string {
    return this.manager.id;
  }

  prompt(input: string): Promise<RunResult> {
    return this.agent.prompt(input, async (signal) => {
      signal.throwIfAborted();
      const history = this.manager.getMessages();
      return buildContext(history);
    });
  }

  abort(): void {
    this.agent.abort();
  }

  subscribe(listener: EventListener): () => void {
    return this.agent.subscribe(listener);
  }
}
```

### 7.1 这段箭头函数什么时候执行

看 prompt 里的第二个参数：

```ts
async (signal) => {
  signal.throwIfAborted();
  const history = this.manager.getMessages();
  return buildContext(history);
}
```

调用 session.prompt 时创建这个函数，再把它交给 Agent。**创建函数不会执行函数体。** Agent 把同一个函数传给 Loop；Loop 每轮调用它时，才取得当前 Manager 的最新消息。

箭头函数使用外层 AgentSession 的 this，所以 this.manager 指向当前会话。这里没有把方法从对象上拆下来调用，也不需要 bind(this)。

这个回调现在没有真正的异步操作，但 async 会把返回数组包装成 Promise，让 Loop 从现在起就使用 await。Step 6 可以在这里等待摘要生成与记录保存；buildContext 本身继续保持同步，只负责把现有数据整理成消息。

### 7.2 从第一轮到第二轮的具体变化

```text
Manager 当前记录：S、H
  → prepareContext() 得到 S、H
  → beforeModel 加入临时说明 R
  → 请求 1：S、R、H

模型返回 A(call_1)
  → message_end 保存 A
执行 read 得到 T(call_1)
  → message_end 保存 T

Manager 当前记录：S、H、A、T
  → 再次 prepareContext() 得到 S、H、A、T
  → beforeModel 加入临时说明 R
  → 请求 2：S、R、H、A、T
```

S 是保存的系统提示，H 是用户输入，A 是工具调用消息，T 是工具结果，R 是只读说明。请求 2 含有新的 A、T，同时 R 仍然只出现一次。这个结果依赖“每轮调用函数”，而不是“每轮复用同一份数组”。

加载已有会话仍使用 Step 4 的校验路径；不完整工具调用不会因为增加了 Context 就被忽略或自动重放。

## 8. src/model-io.ts：观察真正交给 invoke 的消息

日志放在 model.request 内部、invoke 前面。这样所有 beforeModel 都已经运行完，能看到最终消息，而不是某个中间 Hook 处理前的版本。

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

  const debugContext = process.env.ALPHA_DEBUG_CONTEXT === "1";
  let requestNumber = 0;

  return {
    async request(messages, signal) {
      signal.throwIfAborted();
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
```

### 8.1 日志里的对象是什么

`messages.map(message => message.toDict())` 把消息转成便于查看的普通对象，包含 type、content、tool_calls、tool_call_id 等字段。JSON.stringify 的第三个参数 2 表示用两个空格缩进。

这只是打印用的 snapshot。invoke 收到的仍是原来的 LangChain 消息实例数组；没有把日志 JSON 传给模型。

日志表示“即将交给 LangChain invoke 的消息”，不表示服务端已收到或已成功处理。适配器还会转换消息格式，绑定的工具声明也会进入请求，因此它不是完整 HTTP 请求体。这里不抓网络包，也不打印模型配置或 API key；消息正文会完整打印，包括已读到的文件内容。

`requestNumber` 属于当前 createModelIO 创建的对象，每次 request 加一；进程重启并重建对象后从零开始。它只用于观察，不是会话记录编号、全局轮数或恢复检查点。

### 8.2 打开与关闭

设置 `ALPHA_DEBUG_CONTEXT=1` 后，stderr 会多出 `[context]` 和完整消息 JSON；不设置或设为 0 时不打印。它在创建模型适配器时读取一次。

这是一项教学观察功能，可以在掌握调用链后关闭。beforeModel 的临时说明不会因为打开日志而写入会话文件。

## 9. 把完整调用链连起来

```text
CLI → createSession → session.prompt(input)
  → 创建 prepareContext 回调，交给 agent.prompt
  → Agent 提交 HumanMessage，并等待保存
  → runLoop
      → await prepareContext(signal)
          → Manager.getMessages：从已保存记录恢复消息实例
          → buildContext：复制、检查、返回基础上下文
      → beforeModel：调整本轮消息
      → validateHistory：检查调整后的工具配对
      → model.request
          → 可选打印请求消息
          → LangChain invoke
      → 接纳 AIMessage，等待保存
      → 执行全部工具，每个结果都等待保存
      → turn_end / afterTurn
      → 有工具调用则进入下一轮，重新 prepareContext
      → 没有工具调用则返回最终回答
  → agent_end
```

文件读写属于 Manager，构造规则属于 context.ts，准备时机属于 Loop，协调函数由 AgentSession 提供。沿着返回值追踪即可，不需要再增加一层调度器。

## 10. 运行与人工核对

先按路径保存本章五份文件，并确认 app.ts / cli.ts 已采用 Step 4。下面带任务的命令会使用 .env 并产生真实模型请求；无任务参数的 npm start 只显示用法。

### 10.1 检查模块是否接齐

```sh
cd /Users/jquery/ts_files/alpha
npm run check
npm start
```

如果报“需要第二个参数”，检查所有直接 agent.prompt 调用；如果 Loop 还接收 messages 数组，检查 agent-loop.ts 是否已换成本章版本。对外 CLI 继续使用 session.prompt(input)。

### 10.2 对照请求消息与保存历史

```sh
ALPHA_READ_ONLY=1 ALPHA_DEBUG_CONTEXT=1 ALPHA_STOP_AFTER_TURN=0 npm start -- "请调用 read 读取 package.json，再根据结果说明 dependencies。"
```

记下 `[session]` 打印的文件路径，观察 `[context]` 与 `[tool_start]`。如果模型确实请求了一次 read，再返回回答，通常可看到：

| 观察位置 | 预期内容 |
| --- | --- |
| 第一次 context 日志 | 保存的系统提示、临时只读说明、用户输入 |
| read 的 message_end 之后 | 结果已经保存，之后才可能进入第二次请求 |
| 第二次 context 日志 | 上述消息，加上 AI 的调用和对应 ToolMessage |
| 每次请求中的独立只读 SystemMessage | 恰好一条，不逐轮累积 |

模型可能直接回答或调用多次工具，不能仅凭任务文字假定发生了 read。以实际事件、调用 ID 和请求日志为准。

把下方占位路径换成这次实际文件，再查看保存的 JSONL：

```sh
cat ".alpha/sessions/<会话ID>.jsonl"
```

文件第一行是 session 头部，其余是 message 记录。临时只读 SystemMessage 不应成为其中的消息记录。模型最终回答已经保存，但不会出现在产生它的那次请求日志中；比较时要对齐时间点，不能直接要求最终文件行数与第二次请求消息数相等。

### 10.3 加载同一会话，改变本次策略

```sh
ALPHA_READ_ONLY=0 ALPHA_DEBUG_CONTEXT=1 ALPHA_STOP_AFTER_TURN=0 npm start -- --session ".alpha/sessions/<会话ID>.jsonl" "根据刚才读取的内容，列出依赖名称，不要调用工具。"
```

此次请求应包含原会话消息及新的 HumanMessage，但不再额外插入上一进程的只读 SystemMessage。旧回答如果提到只读限制，那段历史正文仍然保留。

加载不会重新读取 package.json 来更新旧工具结果。如果文件后来发生变化，历史中保存的仍是上次读到的内容；需要新结果时应再次调用 read。Context 重建不等于重新执行历史工具。

### 10.4 不改变文件的断点核对

如需进一步理解，可以在现有实现中设置断点，无需新建测试文件或 mock：

1. 在 AgentSession 回调处查看 history，确认第一轮已有新用户输入。
2. 在第二轮同一断点查看 history，确认新增的 AIMessage 与所有 ToolMessage 都在。
3. 在 model.request 处查看 messages，对比 beforeModel 加入的临时说明。
4. 在 Manager.appendMessage 处观察收到的 message，确认请求用的临时说明没有走保存事件。

异常路径可按代码追踪：buildContext 拒绝缺少系统提示或工具未配齐的输入；beforeModel 调整后若破坏配对，Loop 在请求前抛错；保存失败时维持 Step 4 的停止规则。以下验证记录会单独说明本次是否实际运行过这些路径。

## 11. 学完后应该能解释

1. 为什么完整历史与本次请求消息可以不同？
2. Manager.getMessages 是每轮读取文件，还是从内存记录解码？
3. 创建 prepareContext 箭头函数时，函数体是否已经执行？
4. 为什么不能在 prompt 开始时提前计算一个数组并反复返回？
5. 用户输入和工具结果各在什么时候进入下一次上下文？
6. 为什么 buildContext 不再创建一条默认 SystemMessage？
7. 为什么普通数组展开不能隔离消息对象的修改？
8. beforeModel 前后的两次配对检查分别检查什么？
9. 请求日志为什么既不等于最终会话文件，也不等于完整 HTTP 请求体？
10. Step 6 加入摘要后，为什么仍然应该保留原始会话记录？

下一步实现 Compact：选择旧消息生成摘要，保存压缩记录，再由 Context 构造“系统提示 + 摘要 + 保留的近期消息”。本章不按消息条数截断，也不实现 Token 估算或自动恢复任务。

## 12. 本章验证范围

2026-10-20 的验证结果：

- 按 Step 1 → Step 5 顺序提取全部带 `file:` 标记的完整代码块，同名文件使用后续章节版本，组成独立临时项目；各章分别为 11、10、8、7、5 个代码块，最终包含 19 个 TypeScript 源码文件。
- 复用 Alpha 已安装的依赖，在 Node.js 26.7.0 下运行临时项目的 `npm run check`，退出码为 0，无类型错误；未安装或升级依赖。
- 在临时项目运行无任务参数的 `npm start`，正确打印新建与加载用法，退出码为 0；临时目录没有复制 .env，没有发起模型请求或创建会话。
- 根据本机安装的 LangChain 类型声明核对了 toDict、消息转换函数、bindTools 和 invoke；文档中的本地链接均存在。
- 本次只新增 `steps/step5.md`；通过文件内容哈希确认 Alpha 的现有 src 文件保持不变，没有新增或修改测试文件。
- 未执行真实模型工具循环、请求日志与磁盘历史对照、跨进程会话加载、Hook 破坏配对、写盘失败或 Ctrl+C 取消验收。类型检查和无参数启动不能证明这些运行行为；第 10 节提供了后续人工核对步骤。
