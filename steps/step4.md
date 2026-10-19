# Step 4：保存 Session，重启后继续对话

[项目总览](summary.md) · [上一步：Hook 与事件](step3.md)

这一章接着 Step 3，给出 **7 个新增或替换文件的完整内容**。Loop、Hook、事件、调度器、四个工具、模型层、协议检查和项目配置沿用前三章，不新增依赖。本文件是教程；按路径保存代码后，功能才会接入你的练习项目。

本章增加 `AgentSession → Agent → Loop` 这一层调用关系，完成“退出进程，再加载同一个会话文件继续对话”。自动恢复未完成任务、上下文筛选和压缩分别留到后续章节。

## 1. 先看重启后丢失了什么

Step 3 的 Agent 把消息放在内存数组里。第一次运行时，你让模型读取 package.json；进程结束后，这个数组也消失了。第二次运行时，模型不知道上次读到了什么。

希望得到的行为是：

```text
进程 A：新建会话
  SystemMessage：系统提示
  HumanMessage：读取 package.json
  AIMessage：调用 read，id = call_read_1
  ToolMessage：文件内容，tool_call_id = call_read_1
  AIMessage：解释依赖
  → 每条消息按顺序保存到同一个 JSONL 文件
  → 进程退出

进程 B：加载这个文件
  → 读取记录、检查格式
  → 重新创建 SystemMessage / HumanMessage / AIMessage / ToolMessage
  → 检查工具调用与结果配对
  → 把历史装入新的 Agent
  → 追加新的 HumanMessage：“刚才那个项目用了哪些库？”
  → 模型同时看到之前的文件内容和当前问题
```

**恢复消息必须恢复它的类型。** `JSON.parse()` 只能得到普通对象；写成 `raw as BaseMessage[]` 不会调用消息类的构造函数，也不会替你验证数据。前三章的 `instanceof AIMessage` 和 `instanceof ToolMessage` 依赖正确的消息实例。

另一个要区分的情况是：AIMessage 已保存，但 write 的 ToolMessage 还没保存。此时写入可能尚未执行，也可能已经执行完。本章拒绝继续这份不完整历史，不自动再执行一次 write。

## 2. 四个模块分别负责什么

| 模块 | 输入与输出 | 不放在这里的职责 |
| --- | --- | --- |
| `message-codec.ts` | 消息实例 ↔ 可保存的数据 | 不读写文件，不执行工具 |
| `session-types.ts` | 定义文件头与消息记录的 Zod schema | 不决定循环何时继续 |
| `SessionManager` | 创建文件、逐条追加、加载记录 | 不调用模型，不订阅 Agent |
| `AgentSession` | 把 message_end 接到保存，把加载结果装入 Agent | 不重写 Loop、工具执行或协议规则 |

`Agent` 继续保存本次运行的消息和取消状态。新加的 AgentSession **持有** Agent 和 SessionManager，不继承它们。

本章对外入口改为 `createSession()`，CLI 调用 `session.prompt()`；函数内部仍然创建原来的模型、工具、Hook 和 Agent。使用同一个会话文件时，后续消息追加到原文件末尾。

### 2.1 保存顺序直接沿用 Step 3

```text
Loop 发出 message_end
  → Agent 先更新内存 messages
  → await AgentSession 的订阅者
      → await SessionManager.appendMessage(message)
          → 编码消息
          → await appendFile(JSON + 换行)
          → 更新 Manager 的内存记录
  → await CLI 的显示订阅者
  → Loop 继续下一步
```

所以模型的工具调用消息保存失败时，不会继续执行它后面的工具。工具结果保存失败时，工具本身可能已经产生副作用，不能把保存错误包装成“工具没执行”。异常继续向外传播，Agent 沿用 Step 3 的 `deliveryFailed` 标记，禁止在同一个对象上再次 prompt。

这里的完成只表示文件 API 返回成功。本章没有事务、fsync 协议、文件锁或工作区快照，不承诺断电一致性。每个会话文件由一个进程顺序写入，运行期间不要在其他进程中同时追加、删除或编辑它。

### 2.2 与 pi 的对应关系

本地 pi 的 [AgentSession](/Users/jquery/python_files/pi/packages/coding-agent/src/core/agent-session.ts) 在消息完成事件中把消息交给 SessionManager；[SessionManager](/Users/jquery/python_files/pi/packages/coding-agent/src/core/session-manager.ts) 为消息生成记录并保存。

Alpha 复用这个职责关系，但只做线性历史，不复制 pi 的分支树、父节点、延迟首次写盘和其他记录类型。Alpha 的“先 await 保存，再继续”的顺序沿用自己的 Step 3 约定。

## 3. 文件与阅读顺序

```text
src/
├─ message-codec.ts     # 新增：检查并转换消息数据
├─ session-types.ts     # 新增：文件头、消息记录
├─ session-manager.ts   # 新增：JSONL 文件存取
├─ agent-session.ts     # 新增：把保存与加载接到 Agent
├─ agent.ts             # 替换：增加取得消息副本、装入历史
├─ app.ts               # 替换：保留原有组装，返回 AgentSession
└─ cli.ts               # 替换：显示会话路径，支持 --session
```

下面七段带 `file:` 标记的代码都是完整文件。`.gitignore` 沿用 Step 1 的 `.alpha/`，无需修改；会话文件放在 `.alpha/sessions/`。

## 4. src/message-codec.ts：保存数据，恢复实例

`codec` 在这里就是两个转换函数。`encodeMessage()` 接收运行中的消息，返回可写入 JSON 的普通对象；`decodeMessage()` 接收已经校验的数据，调用对应的消息构造函数。

<!-- file: src/message-codec.ts -->
```ts
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
```

### 4.1 这里保存哪些字段

| 消息 | 需要保留的信息 |
| --- | --- |
| 所有消息 | 文本 content、可选 id / name、JSON 格式的 additional_kwargs / response_metadata |
| AIMessage | tool_calls，包括每次调用的 id、name、args；可选 token 用量 |
| ToolMessage | tool_call_id、success / error 状态 |

本章使用字段白名单：不保存任意类的全部属性，也不支持图片内容块、流式消息块、自定义消息、ToolMessage artifact 或任意 JS 对象。前三章只产生这里支持的标准文本消息；如果以后扩展消息能力，要同时扩展 codec 和会话版本约定。

Zod 的对象 schema 默认会去掉未声明字段，因此不能把这套 codec 宣称为“任意 LangChain 消息的无损备份”。保留下来的元数据遵循普通 JSON 语义，不应塞入函数、Date 或特殊数值并期待原样恢复；循环引用、BigInt 等还会使 JSON.stringify 失败。

Step 3 的 denied 在 ToolMessage 中已经映射为 error，正文含拒绝说明，所以这里保存的状态也是 error。`tool_end.raw` 是事件字段，不是消息字段，本章不把它另存一份。

### 4.2 从 parse 到构造函数

以一条工具结果为例：

```text
ToolMessage 实例
  → message.toDict()
      { type: "tool", data: { content, tool_call_id, status, ... } }
  → JSON.stringify / JSON.parse
      得到实际会写入文件的普通数据，可选 undefined 字段被省略
  → savedMessageSchema.parse(raw)
      确认 type、正文、调用 ID、状态等字段有效
  → 保存到消息记录的 message 字段

重新加载后
  → messageEntrySchema 检查记录，同时检查嵌套的 savedMessageSchema
  → decodeMessage(entry.message)
  → switch 进入 tool 分支
  → new ToolMessage(message.data)
```

`z.discriminatedUnion("type", [...])` 按 type 选择对应结构。`SavedMessage` 是从 schema 推导出的联合类型；switch 进入 tool 分支后，TS 知道 data 必须包含 tool_call_id。

`commonData` 是几个 schema 字段组成的普通对象。`...commonData` 把这些字段放进 AI 和 Tool 的 data schema，不是类继承。

`z.json()` 检查 JSON 值；`z.record(z.string(), z.json())` 表示键是字符串、值是 JSON 数据的对象。工具调用的 args 保存为这样的对象，具体工具参数仍由 Dispatch 中各工具的 schema 检查。

`z.array(z.never())` 只允许空数组；无效工具调用不应进入可恢复历史。前三章已经在 `responseCalls()` 拒绝它，本章也不接受有人写进文件的非空 invalid_tool_calls。

### 4.3 为什么没有把 protocol.ts 搬过来

schema 负责检查“这一条记录长什么样”。`protocol.ts` 负责“消息能否用于模型对话、工具调用和结果是否配对”。两种检查解决不同问题。

这里不重新实现 pending ID 集合。后面的 Agent.replaceMessages 在加载边界复用 `responseCalls()` 和 `validateHistory()`；Loop 在发送请求前仍检查经过 beforeModel 调整的消息。不会在每次追加记录时重新扫描整段历史。

## 5. src/session-types.ts：记录外壳与消息内容

JSONL 是每行一个 JSON 对象。整个文件不是一个 JSON 数组；加载时先按行拆开，再逐行 JSON.parse。

第一行保存会话身份，后面的每一行保存一条消息：

```text
第 1 行：{ type: "session", version: 1, id, timestamp, cwd }
第 2 行：{ type: "message", id, timestamp, message: SystemMessage 的保存数据 }
第 3 行：{ type: "message", id, timestamp, message: HumanMessage 的保存数据 }
第 4 行：{ type: "message", id, timestamp, message: AIMessage 的保存数据 }
……
```

这是结构示意，不是可直接粘贴的 JSON。正文里的换行由 JSON.stringify 转义，只有记录末尾的 `\n` 才作为文件中的分行符。

<!-- file: src/session-types.ts -->
```ts
import { z } from "zod";
import { savedMessageSchema } from "./message-codec.ts";

export const sessionHeaderSchema = z.object({
  type: z.literal("session"),
  version: z.literal(1),
  id: z.uuid(),
  timestamp: z.iso.datetime(),
  cwd: z.string().min(1),
});

export const messageEntrySchema = z.object({
  type: z.literal("message"),
  id: z.uuid(),
  timestamp: z.iso.datetime(),
  message: savedMessageSchema,
});

export const sessionRecordSchema = z.discriminatedUnion("type", [
  sessionHeaderSchema,
  messageEntrySchema,
]);

export type SessionHeader = z.infer<typeof sessionHeaderSchema>;
export type MessageEntry = z.infer<typeof messageEntrySchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
```

这里有三种不同身份，不能混用：

- 头部的 id：标识整个会话，也用于生成文件名。
- 消息记录的 id：标识文件中的这一条记录，由本地 randomUUID 生成。
- AI 的 tool_calls[].id 与 Tool 的 tool_call_id：标识同一次工具调用，必须原样对应。

消息自己的可选 message.data.id 也会保留，但不拿它替代本地记录 ID。模型服务不一定给每条消息提供 ID。

version 固定为 1，不认识的版本直接拒绝。timestamp 使用 ISO 时间字符串，记录用于查看；消息先后顺序以文件行序为准，不按时间重新排序。

本章只出现 session 和 message 两种记录。压缩和检查点尚未实现，不提前增加空类型。

## 6. src/session-manager.ts：先写入成功，再更新记录

<!-- file: src/session-manager.ts -->
```ts
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BaseMessage } from "@langchain/core/messages";
import { decodeMessage, encodeMessage } from "./message-codec.ts";
import { messageEntrySchema, sessionHeaderSchema, sessionRecordSchema } from "./session-types.ts";
import type { MessageEntry, SessionHeader, SessionRecord } from "./session-types.ts";

export class SessionManager {
  readonly filePath: string;
  private header: SessionHeader;
  private entries: MessageEntry[];
  private writing: boolean;
  private failed: boolean;

  private constructor(filePath: string, header: SessionHeader, entries: MessageEntry[]) {
    this.filePath = filePath;
    this.header = header;
    this.entries = entries;
    this.writing = false;
    this.failed = false;
  }

  static async create(cwd: string, messages: BaseMessage[]): Promise<SessionManager> {
    const root = await realpath(cwd);
    const header = sessionHeaderSchema.parse({
      type: "session",
      version: 1,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: root,
    });
    const entries: MessageEntry[] = [];
    for (const message of messages) {
      entries.push(messageEntrySchema.parse({
        type: "message",
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        message: encodeMessage(message),
      }));
    }

    const directory = join(root, ".alpha", "sessions");
    await mkdir(directory, { recursive: true });
    const filePath = join(directory, `${header.id}.jsonl`);
    const records: SessionRecord[] = [header, ...entries];
    const text = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await writeFile(filePath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return new SessionManager(filePath, header, entries);
  }

  static async load(filePath: string, cwd: string): Promise<SessionManager> {
    const root = await realpath(cwd);
    const absolutePath = resolve(root, filePath);
    const text = await readFile(absolutePath, "utf8");
    if (text === "" || !text.endsWith("\n")) {
      throw new Error(`${absolutePath}：会话为空或末行没有完整结束；本章不自动修复文件`);
    }

    const lines = text.slice(0, -1).split("\n");
    const ids = new Set<string>();
    const entries: MessageEntry[] = [];
    let header: SessionHeader | undefined;

    for (let index = 0; index < lines.length; index += 1) {
      try {
        const raw: unknown = JSON.parse(lines[index]);
        const record = sessionRecordSchema.parse(raw);
        if (ids.has(record.id)) {
          throw new Error(`记录 ID 重复：${record.id}`);
        }
        ids.add(record.id);

        if (index === 0) {
          if (record.type !== "session") {
            throw new Error("第一行必须是 session 头部");
          }
          if (record.cwd !== root) {
            throw new Error(`工作目录不一致：会话属于 ${record.cwd}，当前为 ${root}`);
          }
          header = record;
        } else {
          if (record.type !== "message") {
            throw new Error("头部之后只能出现 message 记录");
          }
          entries.push(record);
        }
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${absolutePath}:${index + 1}：${detail}`, { cause: error });
      }
    }

    if (header === undefined) {
      throw new Error(`${absolutePath}：缺少 session 头部`);
    }
    return new SessionManager(absolutePath, header, entries);
  }

  get id(): string {
    return this.header.id;
  }

  getMessages(): BaseMessage[] {
    return this.entries.map((entry) => decodeMessage(structuredClone(entry.message)));
  }

  async appendMessage(message: BaseMessage): Promise<void> {
    if (this.failed) {
      throw new Error("会话之前保存失败，请检查文件后重新加载，不能直接重试追加");
    }
    if (this.writing) {
      throw new Error("会话正在写入，必须等待上一次追加结束");
    }

    this.writing = true;
    try {
      const entry = messageEntrySchema.parse({
        type: "message",
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        message: encodeMessage(message),
      });
      await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf8");
      this.entries.push(entry);
    } catch (error: unknown) {
      this.failed = true;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`保存会话失败 ${this.filePath}：${detail}`, { cause: error });
    } finally {
      this.writing = false;
    }
  }
}
```

### 6.1 为什么 create / load 是 static async

普通 constructor 不能写成 async，但创建或读取文件需要 await。因此构造函数只负责字段赋值，两个静态方法完成异步准备后再返回实例：

```text
await SessionManager.create(cwd, messages)
  → 规范化工作目录
  → 构造文件头与初始消息记录
  → 创建目录、写文件
  → new SessionManager(...)
```

`private constructor` 表示外部不能跳过这些步骤直接 new。`static` 表示方法属于 SessionManager 类，调用时不需要已有实例。

新文件同时保存头部和初始 SystemMessage，使用 `flag: "wx"`；万一同名文件已存在就报错，不覆盖。`mode: 0o600` 设置新文件的权限，实际权限还受系统 umask 约束。

`realpath(cwd)` 让同一目录的符号链接别名归一。恢复时比较头部 cwd，避免把项目 A 的相对文件路径拿到项目 B 中继续执行。会话文件路径可以是绝对路径，也可以相对当前项目目录。

### 6.2 load 怎么报告坏数据

加载只读文件，不会顺便重写或清理它。检查分为两层：

1. Manager 检查末尾换行、逐行 JSON 和 schema、头部位置、版本、工作目录、重复记录 ID。
2. Agent 装入历史时检查首条系统消息、模型消息以及工具调用配对。

中间的空白行也算错误，不能用 `filter(Boolean)` 把坏数据悄悄跳过去。每一行的解析异常会附带文件路径和一基行号，例如 `...jsonl:5`。

本章的写入器每条记录都以换行结束，所以加载器要求文件也以换行结束。末行即使恰好是合法 JSON，只要没有末尾换行也拒绝；这是一条保守的格式约定，不是在断言文件一定损坏。

### 6.3 getMessages 为什么重新构造对象

Manager 保存的是 MessageEntry[]，Agent 需要的是 BaseMessage[]。`map()` 对每条记录调用 decodeMessage，组合成新的消息数组。

先 structuredClone 保存数据，是为了不让新消息里的元数据和 Manager 的记录共享可变对象。这里复制的是普通数据，再调用消息类构造函数，顺序与 Step 3 的消息副本思路一致。

### 6.4 appendMessage 的失败边界

`writing` 是当前对象的并发调用检查：上一次 append 没结束，就拒绝下一次。它不是文件锁，无法阻止另一个进程写同一个文件。正常主线由 Agent 逐个 await 事件，本来就是串行的。

`failed` 记住曾经保存失败。文件写入抛错时，不能仅凭异常认定磁盘上一个字节也没写，所以不能在同一个 Manager 上盲目重试。应检查实际文件，重新加载；有半行或缺失结果时本章会停止。

Manager 在写入成功后才 `entries.push(entry)`。这不代表 Agent 的内存也在此时才更新：Agent 已经先接纳消息，因此保存失败后两者可能不同步，Step 3 的 deliveryFailed 正是用于阻止带着这种状态继续运行。

`appendFile` 不使用运行的取消 signal。已经产生的工具结果要尽量保存，不能因为 Ctrl+C 就主动丢弃结果。取消的检查仍在原来的模型、工具和 Loop 边界进行。

## 7. src/agent-session.ts：注册保存订阅者

<!-- file: src/agent-session.ts -->
```ts
import type { Agent } from "./agent.ts";
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
    return this.agent.prompt(input);
  }

  abort(): void {
    this.agent.abort();
  }

  subscribe(listener: EventListener): () => void {
    return this.agent.subscribe(listener);
  }
}
```

### 7.1 新建和加载走两条入口

新建时，Agent 已经带着默认 SystemMessage。`agent.getMessages()` 取得副本，Manager 将它作为初始记录写入文件，再注册事件订阅者。

加载时，先读已有文件，再把恢复的消息整体交给 `agent.replaceMessages()`。它**替换**新 Agent 的默认历史，不是在默认 SystemMessage 后面再拼一遍旧历史，也不会为旧消息重新发 message_end。

加载成功后才注册保存订阅者。于是旧消息不会再次写盘，接下来用户的新输入才会成为文件末尾的新记录。

### 7.2 为什么 subscribe 里面必须 await

箭头函数捕获当前 AgentSession 的 this。事件来临时，它找到自己的 manager 并等待追加：

```ts
await this.manager.appendMessage(event.message);
```

如果只调用 appendMessage 却既不 await 也不 return Promise，Agent 会认为订阅者已经完成，后续工具可能在保存仍未结束时启动，写入异常也不能沿 prompt 返回。

这里只保存 message_end。tool_start、tool_end、turn_end、agent_end 继续用于终端观察，不作为恢复运行位置的依据。文件头的初始系统消息由 create 写入一次，没有伪造事件。

### 7.3 对外方法为什么看起来只是转发

现在 session.prompt 只是把调用交给 Agent，因为上下文构造和压缩还没加入。后续步骤会在这个协调层准备上下文；不需要为此把文件读写塞进 Agent 或 Loop。

工厂函数每次创建一个全新的 Agent，只给它绑定一个 AgentSession。保存订阅者随这个会话对象使用期间保留，CLI 的显示订阅在运行结束后取消。这里不提供把同一个 Agent 反复绑定多个 Session 的 API 流程。

## 8. src/agent.ts：增加历史读取与替换

新增 `getMessages()` 和 `replaceMessages()`，其余事件更新、取消、异常和 Loop 调用保持 Step 3 的行为。下面仍给出完整文件，避免只复制补丁漏掉导入。

<!-- file: src/agent.ts -->
```ts
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { runLoop } from "./agent-loop.ts";
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

`getMessages()` 返回副本，调用者改数组或消息不会改到运行中的历史。

`replaceMessages()` 先做检查，最后才赋给 this.messages。若文件有错误，原 Agent 的历史保持原样；它不会先丢掉旧状态，再发现新状态不可用。

输入边界检查顺序为：

```text
确认 Agent 当前没有运行、没有发生事件通知失败
  → 复制输入消息
  → 首条必须是 SystemMessage
  → 对 AIMessage 调用 responseCalls
  → validateHistory 检查全部调用与结果
  → this.messages = restored
```

这里使用前三章的 protocol.ts，未新增第二份调用配对算法。它会拒绝含未完成工具调用的文件；报错时不替模型补写“成功结果”，也不直接跳过调用。

加载不是任务恢复：完整的工具结果后可以追加新的用户问题，但不会自动执行“下一轮请求”。只保存了 HumanMessage、尚未收到模型回答的历史也可能通过配对检查；随后仍是接收用户的新输入，不把旧任务自动重试一次。

## 9. src/app.ts：保留模型与 Hook，增加 Session 工厂

<!-- file: src/app.ts -->
```ts
import { SystemMessage } from "@langchain/core/messages";
import { Agent } from "./agent.ts";
import { AgentSession } from "./agent-session.ts";
import { bashTool } from "./builtin-tools/bash.ts";
import { editTool } from "./builtin-tools/edit.ts";
import { readTool } from "./builtin-tools/read.ts";
import { writeTool } from "./builtin-tools/write.ts";
import type { Hook } from "./hooks.ts";
import { createModelIO } from "./model-io.ts";
import { truncateOutput } from "./tools.ts";
import type { Tool } from "./tools.ts";

function createAgent(cwd: string): Agent {
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

export async function createSession(cwd: string, filePath?: string): Promise<AgentSession> {
  const agent = createAgent(cwd);
  if (filePath !== undefined) {
    return await AgentSession.load(agent, cwd, filePath);
  }
  return await AgentSession.create(agent, cwd);
}
```

原来的 createAgent 变成模块内部的组装函数；对外使用异步 createSession，因为它需要等待文件操作。

未传入 filePath 时新建会话；提供时加载指定文件。文件不存在、权限不足、格式错误都向外报错，不能偷偷退回新建会话，否则用户会误以为历史已经恢复。

恢复使用当前进程的模型配置、工具函数和 Hook。它们没有被序列化到 JSON；保存的是历史消息，而不是整个程序。保存的 SystemMessage 会恢复使用，`ALPHA_READ_ONLY` 等临时策略由当前进程的 Hook 决定。

这里先检查模型配置并创建 Agent，再操作会话文件。因此缺少 API key 的启动不会留下空会话文件。创建模型对象本身不会调用 invoke。

## 10. src/cli.ts：新建，或指定文件继续

<!-- file: src/cli.ts -->
```ts
import { createSession } from "./app.ts";
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
  const args = process.argv.slice(2);
  let filePath: string | undefined;
  if (args[0] === "--session") {
    filePath = args[1];
    if (filePath === undefined || filePath.trim() === "") {
      throw new Error("--session 后面需要会话文件路径");
    }
    args.splice(0, 2);
  } else if (args[0]?.startsWith("--")) {
    throw new Error(`未知选项：${args[0]}`);
  }
  const input = args.join(" ").trim();
  if (input === "") {
    console.log('新建：npm start -- "读取 package.json，说明项目依赖"');
    console.log('加载：npm start -- --session ".alpha/sessions/<会话ID>.jsonl" "继续讨论"');
    return;
  }

  const session = await createSession(process.cwd(), filePath);
  console.error(`[session] ${session.id} ${session.filePath}`);
  const unsubscribe = session.subscribe(printEvent);
  let interrupted = false;

  function onInterrupt(): void {
    interrupted = true;
    session.abort();
  }

  process.on("SIGINT", onInterrupt);
  try {
    const result = await session.prompt(input);
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

CLI 仍然是每次进程处理一条用户输入。连续对话通过多次启动并指定同一个文件完成，不引入交互式输入循环。

`args.splice(0, 2)` 移除 `--session` 和路径，剩余参数用空格拼成用户问题。这个简化的 CLI 只接受开头的一个可选 `--session <路径>`，不实现复杂选项解析。

保存订阅者在 createSession 内先注册，printEvent 后注册。因此正常情况下，CLI 的 `[message_end]` 日志出现在该消息的追加操作成功以后。系统提示在新建时已经保存，不会额外打印一次 message_end。

退出码沿用 Step 3：正常回答 0、策略停止 2、普通失败 1、收到 Ctrl+C 后失败退出 130。会话创建或加载失败时，还没有进入 prompt，错误交给最外层 catch 输出。

## 11. 用一个 read 任务追完整条链

```text
CLI → await createSession(cwd)
  → createAgent：模型、工具、Hook、初始系统消息
  → AgentSession.create
      → SessionManager.create：保存头部和系统消息
      → 注册消息保存订阅者
  → CLI 注册显示订阅者

session.prompt("读取 package.json")
  → agent.prompt
      → HumanMessage：Agent 接纳 → Session 保存 → CLI 显示
      → runLoop
          → beforeModel → validateHistory → model.request
          → responseCalls → afterModel
          → AIMessage：Agent 接纳 → Session 保存 → CLI 显示
          → executeTool(read)
          → ToolMessage：Agent 接纳 → Session 保存 → CLI 显示
          → tool_end → turn_end → afterTurn
          → 下一次模型请求，提交最终 AIMessage
      → agent_end
  → CLI 打印回答，进程结束

下次 CLI → await createSession(cwd, 原文件路径)
  → Manager.load → 解析记录
  → Manager.getMessages → decodeMessage → 消息实例
  → Agent.replaceMessages → 检查后整体替换历史
  → 注册保存、显示订阅者
  → prompt(新的问题)，只追加新消息
```

注意 AIMessage 在工具执行前保存，所以磁盘记录可能暂时存在“调用还没有结果”的前缀。这是正常的写入过程。只有读取整个文件、准备继续对话时，才要求工具调用已经配齐结果。

## 12. 运行与人工核对

本节的模型任务会使用 `.env` 并产生真实请求。先按路径保存七份文件；如果你的练习源码与前三章参考代码不同，需要先核对事件等待、RunResult 和 protocol.ts 是否一致。

### 12.1 类型检查与无参数启动

```sh
cd /Users/jquery/ts_files/alpha
npm run check
npm start
```

无参数启动应打印新建与加载两种用法，不请求模型，也不创建会话。若 TS 提示 replaceMessages 不存在，检查 Agent 是否已经换成本章版本；若仍然导入 createAgent，检查 CLI 是否换成 createSession 并使用 await。

### 12.2 第一次运行，得到会话文件

```sh
npm start -- "请调用 read 读取 package.json，然后解释 dependencies。"
```

记下 stderr 打印的 `[session]` 文件路径。检查实际 read 事件和最终回答后，在终端查看这个文件；将下面路径替换成真实路径：

```sh
cat ".alpha/sessions/<会话ID>.jsonl"
wc -l ".alpha/sessions/<会话ID>.jsonl"
```

只有一次 read 且随后直接回答时，通常是 6 行：头部、系统、用户、AI 调用、工具结果、AI 回答。模型可能选择其他调用过程，所以不要把行数固定为验收结论。

重点核对 AI 的 tool_calls[].id 与 Tool 的 tool_call_id 一致，正文和状态都存在。观察到 `[session]` 只说明已创建或加载文件，不能单独证明后续任务完成。

### 12.3 新进程加载，再问一次

```sh
npm start -- --session ".alpha/sessions/<会话ID>.jsonl" "根据刚才读到的 package.json，列出 dependencies 的名称；这次不必重新读取文件。"
```

应显示同一个会话 ID 和路径。原有记录保留，新消息追加到末尾，没有再次写入文件头或旧系统提示。

在 Agent.replaceMessages 末尾设断点，可以确认恢复后的 AI 和工具消息分别是 AIMessage、ToolMessage 实例，调用 ID 仍一致；在模型请求处可以确认旧内容进入请求。模型说“我记得”本身不能证明实现正确。

加载的是之前读到的文件内容，不会自动刷新当前磁盘文件。如果 package.json 已改变，要明确让模型重新读取。

### 12.4 保存完整工具轮后再继续

```sh
ALPHA_STOP_AFTER_TURN=1 npm start -- "请调用 read 读取 package.json，然后解释项目依赖。"
```

如果模型确实调用了 read，预期工具结果已保存，返回 stopped。接着去掉这个环境变量，用新打印的会话路径发出一条新输入：

```sh
npm start -- --session ".alpha/sessions/<会话ID>.jsonl" "现在根据已经读到的内容继续回答。"
```

这验证的是“用户发出新输入后继续对话”，不是检查点自动续跑。若第一次没有调用工具，这次运行无法验证 afterTurn 的停止分支。

### 12.5 异常和边界应如何表现

以下列出人工验收条件，不提供修改原始会话的破坏性命令。需要检查坏数据分支时，应使用独立副本并保留原文件。

| 情况 | 预期行为 |
| --- | --- |
| 指定文件不存在 | 明确报读取错误，不自动新建 |
| JSON 损坏、空白行、未知版本、重复记录 ID | 报错并指出位置，不跳过记录 |
| 文件最后没有换行 | 停止加载，不自动截断或补写 |
| 在不同项目目录加载 | 报工作目录不一致 |
| AI 工具调用缺少结果 | 配对检查失败，不重放、不补造结果 |
| 新消息写入失败 | prompt 抛错，后续工作停止，当前对象不能再次运行 |
| Ctrl+C 发生在工具中 | 沿用 Step 3，尽量补齐本批结果并保存，再停止；已发生的副作用不会撤销 |

这些条件没有在本章自动生成测试文件、测试替身或断言。跨进程对话、错误分支和取消行为需要分别取得运行证据。

## 13. 学完后应该能解释

1. Agent.messages、Manager.entries 和文件中的 JSONL 分别保存什么？
2. 为什么 JSON.parse 得到的对象不能直接当 AIMessage 使用？
3. 记录 ID、模型消息 ID、工具调用 ID 分别解决什么问题？
4. 哪一层决定何时保存，哪一层实际写文件？
5. 为什么订阅者要返回可等待的 Promise？
6. 为什么 Agent 先更新消息，而 Manager 在写入成功后才更新 entries？
7. 新进程为什么替换初始历史，而不是追加到默认 SystemMessage 后面？
8. 为什么完整工具轮后的历史可以接收新问题，缺工具结果时必须停止？
9. 为什么模型配置、Hook 和工具执行函数不会从 JSON 恢复？
10. 为什么 Session 保存还不是 Checkpoint，也不负责文件回滚？

下一步实现 Context：会话记录保存发生过的消息，而模型输入由历史构造。现在两者大体一致，Step 5 会明确区分它们，并为压缩预留接入位置。

## 14. API 依据与本章验证

消息的 toDict、构造函数、工具调用字段和用量字段已核对 alpha 安装的 `@langchain/core` 声明及实现；schema 使用现有 Zod 4。JSON 值的检查见 [Zod 官方 API](https://zod.dev/api#json)，文件追加与创建标志见 [Node 文件系统文档](https://nodejs.org/api/fs.html#fspromisesappendfilepath-data-options)。以项目锁定依赖和本机 Node 类型检查为本章接口依据。

2026-10-19 的验证结果：

- 在独立临时目录按 Step 1 → Step 2 → Step 3 → Step 4 顺序提取全部完整文件代码块，分别为 11、10、8、7 个；后一章覆盖前一章同名文件，组成可检查的项目。
- 复用 alpha 已安装的依赖，在 Node.js 26.7.0 下运行 `npm run check` 通过，无类型错误；未新增依赖，未验证全新安装。
- 无参数运行 `npm start`，正确打印新建和加载两种用法；临时目录没有 `.env`，移除模型环境变量后带任务启动，正确报告缺少 `OPENAI_API_KEY`，退出码为 1，没有发起模型请求。
- 文档中的本地文件链接均存在。本次只新增 `steps/step4.md`，未覆盖 alpha 的实际练习源码，未新增或修改测试文件。
- 未实际执行消息落盘与加载、真实模型对话、跨进程续聊、文件损坏分支、写盘失败或 Ctrl+C 验收。类型检查和 CLI 启动不能替代这些运行行为的验证；第 12 节列出了人工核对步骤。

