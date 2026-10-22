# Step 7：Checkpoint，在明确的稳定位置恢复

[项目总览](summary.md) · [上一步：Compact](step6.md)

本章接着 Step 6，给出 **8 个新增或替换文件的完整内容**，新增检查点记录、恢复判断和 `--resume`。沿用 LangChain、Zod 与线性 JSONL，不增加依赖。本文是教程，不会自动覆盖你的练习源码。

## 1. 问题：保存了历史，仍然不知道下一步做什么

Step 4 的 `--session <路径> <新问题>` 是加载后接收新输入。它不会自动继续上一个任务。现在考虑两个中断位置：

```text
位置 A：
  AIMessage：read package.json
  ToolMessage：已经保存读取结果
  检查点：完成 1 轮，下一步请求模型
  进程退出

位置 B：
  AIMessage：bash 执行某个修改命令，已经保存
  命令可能已经运行，但结果尚未保存
  进程退出
```

A 可以加载已有结果，继续请求模型，不重新执行原 read。B 仅从 JSONL 无法知道命令是否执行成功，不能重放命令来“补齐历史”。

本章解决的是 A，并对 B 明确报错。恢复不会回滚文件，也不保证模型下一次不会提出语义相同的新工具调用；它只保证恢复代码不直接重放已经记录的那一批旧调用。

### 1.1 和 pi 的关系

继续参考 pi 的 [Agent](/Users/jquery/python_files/pi/packages/agent/src/agent.ts)、[Loop](/Users/jquery/python_files/pi/packages/agent/src/agent-loop.ts) 与追加式 [SessionManager](/Users/jquery/python_files/pi/packages/coding-agent/src/core/session-manager.ts) 的职责分工。

**本章 Checkpoint 是 Alpha 增加的教学能力。** 不声称 pi coding-agent 主线存在一个与下文相同的 Checkpoint 类，也不混入另一套 harness 状态机。我们只保存数据和恢复入口，不保存 JS 调用栈、Promise、AbortController 或工具函数。

## 2. 两个入口与三种判断

| 情况 | 入口或结果 |
| --- | --- |
| 文件末尾是 next=input 的检查点 | `--session <路径> <新问题>`，追加新 HumanMessage |
| 文件末尾是 next=model 的检查点 | `--resume <路径>`，直接进入下一轮，不追加 HumanMessage |
| 检查点后有任何新记录，或没有合法检查点 | 拒绝自动继续，保留文件，报告位置 |

最后一条故意保守。即使尾部只是完整回答、完整工具结果或 compaction，也不擅自推断程序是否完成策略处理。第一版没有“分析尾部后补建检查点”的恢复器。

例如旧检查点说“可以请求模型”，后面已有一条新的 AI 工具调用：不能忽略这条调用，再从旧点请求一次。工具可能已经执行，回退会造成重复操作。

### 2.1 为什么不直接在 turn_end 保存

Step 3 的顺序是 `turn_end → afterTurn → 继续或停止`。在 turn_end 保存 next=model 太早：后面的 afterTurn 可能要求停止。

本章增加一个小事件 `run_boundary`，放在整批消息保存完成、afterTurn 已做出决定之后：

```text
全部 ToolMessage 保存完毕
  → turn_end
  → afterTurn
  → run_boundary(next=model 或 input)
      → AgentSession 等待 appendCheckpoint
  → 进入下一轮，或返回结果
```

这里新增事件有明确用途：通知上层“循环已经决定下一步”。不让 Loop 认识磁盘路径，也不让普通 tool_end 暗中承担恢复语义。

## 3. 文件与数据格式

| 文件 | 本章职责 |
| --- | --- |
| session-types.ts，替换 | 增加 checkpoint 结构 |
| checkpoint.ts，新增 | 验证历史位置、轮数与文件尾 |
| session-manager.ts，替换 | 追加检查点，加载时检查恢复条件 |
| events.ts，替换 | 新增 run_boundary |
| agent-loop.ts，替换 | 从指定轮数继续，发布稳定位置 |
| agent.ts，替换 | prompt / resume 共享一次运行过程 |
| agent-session.ts，替换 | 保存边界，选择新任务或恢复入口 |
| cli.ts，替换 | 解析 --resume，显示检查点 |

Step 6 的 app.ts、context.ts、compact.ts、budget.ts、model-io.ts，以及更早章节的工具、Hook、codec 沿用。Context 只处理 message 和 compaction，因此 checkpoint 不会变成发给模型的消息。

会话格式升级为 **version: 3**，不自动加载或迁移旧版本。练习本章新建会话；保留旧文件供对应章节的程序读取，不要只改版本号。

## 4. src/session-types.ts：检查点只保存必要信息

<!-- file: src/session-types.ts -->
```ts
import { z } from "zod";
import { savedMessageSchema } from "./message-codec.ts";

export const sessionHeaderSchema = z.object({
  type: z.literal("session"),
  version: z.literal(3),
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

export const compactionEntrySchema = z.object({
  type: z.literal("compaction"),
  id: z.uuid(),
  timestamp: z.iso.datetime(),
  summary: z.string().trim().min(1).max(12000),
  firstKeptEntryId: z.uuid(),
  tokensBefore: z.number().int().nonnegative(),
  tokensAfter: z.number().int().nonnegative(),
});

export const checkpointEntrySchema = z.object({
  type: z.literal("checkpoint"),
  id: z.uuid(),
  timestamp: z.iso.datetime(),
  sessionId: z.uuid(),
  afterEntryId: z.uuid(),
  next: z.enum(["model", "input"]),
  turns: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive(),
});

export const sessionRecordSchema = z.discriminatedUnion("type", [
  sessionHeaderSchema,
  messageEntrySchema,
  compactionEntrySchema,
  checkpointEntrySchema,
]);

export type SessionHeader = z.infer<typeof sessionHeaderSchema>;
export type MessageEntry = z.infer<typeof messageEntrySchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export type CompactionEntry = z.infer<typeof compactionEntrySchema>;
export type CheckpointEntry = z.infer<typeof checkpointEntrySchema>;
export type SessionEntry = MessageEntry | CompactionEntry | CheckpointEntry;
```

下面仍是结构示意：

```text
{
  type: "checkpoint",
  id: 检查点自己的记录 ID,
  sessionId: 当前会话 ID,
  afterEntryId: 紧挨着它前面的记录 ID,
  next: "model",
  turns: 2,
  maxTurns: 8
}
```

`afterEntryId` 标出它对应的历史位置，可以指向消息或压缩记录；不使用行号，追加新记录不会改变旧 ID。它与 Compact 的 firstKeptEntryId 不同：一个决定恢复位置，一个决定模型上下文的保留起点。

turns 表示当前用户任务已完成的主模型轮数。摘要请求不计入；新用户输入把轮数从零开始。恢复保留原 maxTurns，例如已完成 2/8，则从第 3 轮开始，最多再执行 6 轮，不重新获得 8 轮额度。

## 5. src/checkpoint.ts：先检查，后决定能不能继续

<!-- file: src/checkpoint.ts -->
```ts
import { buildContext } from "./context.ts";
import type { CheckpointEntry, MessageEntry, SessionEntry } from "./session-types.ts";

export function inspectRecovery(
  entries: SessionEntry[],
  sessionId: string,
): CheckpointEntry {
  let latest: CheckpointEntry | undefined;
  let lastMessage: MessageEntry | undefined;
  let turns = 0;
  let taskMaxTurns: number | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === "message") {
      lastMessage = entry;
      if (entry.message.type === "human") {
        turns = 0;
        taskMaxTurns = undefined;
      } else if (entry.message.type === "ai") {
        turns += 1;
      }
    } else if (entry.type === "checkpoint") {
      if (entry.sessionId !== sessionId || entry.afterEntryId !== entries[index - 1]?.id) {
        throw new Error(`检查点的会话或历史位置不匹配：${entry.id}`);
      }
      // 历史即使后来配齐，也不能让早先未配齐处的检查点变得有效。
      buildContext(entries.slice(0, index));
      if (entry.turns !== turns || entry.turns > entry.maxTurns) {
        throw new Error(`检查点轮数与实际消息不一致：${entry.id}`);
      }
      if (taskMaxTurns !== undefined && taskMaxTurns !== entry.maxTurns) {
        throw new Error(`同一任务的轮数上限发生变化：${entry.id}`);
      }
      taskMaxTurns = entry.maxTurns;
      if (entry.next === "model") {
        if (turns < 1 || turns >= entry.maxTurns || lastMessage?.message.type !== "tool") {
          throw new Error(`检查点不满足继续请求模型的条件：${entry.id}`);
        }
      } else {
        const type = lastMessage?.message.type;
        const initial = turns === 0 && index === 1 && type === "system";
        if (!initial && (turns < 1 || (type !== "ai" && type !== "tool"))) {
          throw new Error(`检查点不满足等待新输入的条件：${entry.id}`);
        }
      }
      latest = entry;
    }
  }
  if (latest === undefined) {
    throw new Error("会话没有检查点，不能自动继续；保留原文件并人工核对");
  }
  const tail = entries.at(-1);
  if (tail?.id !== latest.id) {
    throw new Error(
      `检查点 ${latest.id} 后还有记录，末条为 ${tail?.type} ${tail?.id}。` +
      "不能回退或忽略这些记录；工具副作用可能已经发生，不会自动重放。",
    );
  }
  return structuredClone(latest);
}
```

这段函数不读文件、不调用模型、不执行工具。Manager 先逐行解析并检查 schema，再把记录交给它。

### 5.1 为什么逐个检查旧检查点

不能只检查最新点，然后让错误的旧记录混过去。每遇到 checkpoint，函数检查：

1. sessionId 是否一致，afterEntryId 是否就是前一条记录。
2. 在该点之前的历史是否已经完整配齐工具结果。
3. 从最近一条真实 HumanMessage 起，AIMessage 数量是否等于 turns。
4. 同一任务的 maxTurns 是否保持一致。
5. next=model 是否确实处于工具批次之后，且还剩请求额度。

检查历史前缀很重要：不能因为后面补上了 ToolMessage，就认为一个过早写入的旧检查点合法。这里复用 buildContext → protocol.ts，不复制另一套工具调用 ID 配对算法。

初始系统提示后允许 `next=input, turns=0`。后续 input 检查点可以来自最终回答、afterTurn 停止或轮数耗尽。它们都表示下一次需要用户的新输入，不代表任务都已成功完成。

### 5.2 检查点在文件末尾才可恢复

函数扫描结束后，最新检查点必须就是最后一条记录。否则错误会指出最新点以及文件末条的类型与 ID。不会删行、补结果、忽略尾部或自动重放。

这是一套顺序、结构和协议检查，不是文件防篡改认证。没有哈希签名，也不验证外部工作区是否改变。重复扫描历史前缀的写法便于阅读，但大文件上开销高；本章不引入缓存或索引优化。

## 6. src/session-manager.ts：消息与检查点使用同一条追加路径

<!-- file: src/session-manager.ts -->
```ts
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BaseMessage } from "@langchain/core/messages";
import { decodeMessage, encodeMessage } from "./message-codec.ts";
import { checkpointEntrySchema, compactionEntrySchema, messageEntrySchema, sessionHeaderSchema, sessionRecordSchema } from "./session-types.ts";
import type { CheckpointEntry, CompactionEntry, SessionEntry, SessionHeader, SessionRecord } from "./session-types.ts";

import { inspectRecovery } from "./checkpoint.ts";
import { buildContext } from "./context.ts";

export class SessionManager {
  readonly filePath: string;
  private header: SessionHeader;
  private entries: SessionEntry[];
  private writing: boolean;
  private failed: boolean;

  private constructor(filePath: string, header: SessionHeader, entries: SessionEntry[]) {
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
      version: 3,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: root,
    });
    const entries: SessionEntry[] = [];
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
    const entries: SessionEntry[] = [];
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
          if (record.type === "session") {
            throw new Error("头部不能重复出现");
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
    inspectRecovery(entries, header.id);
    buildContext(entries);
    return new SessionManager(absolutePath, header, entries);
  }

  get id(): string {
    return this.header.id;
  }


  getEntries(): SessionEntry[] {
    if (this.failed) {
      throw new Error("会话曾写入失败，磁盘状态不确定；请检查文件后重新加载");
    }
    return structuredClone(this.entries);
  }

  getMessages(): BaseMessage[] {
    const messages: BaseMessage[] = [];
    for (const entry of this.entries) {
      if (entry.type === "message") {
        messages.push(decodeMessage(structuredClone(entry.message)));
      }
    }
    return messages;
  }

  async appendMessage(message: BaseMessage): Promise<void> {
    const entry = messageEntrySchema.parse({
      type: "message",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      message: encodeMessage(message),
    });
    await this.appendEntry(entry);
  }

  async appendCompaction(entry: CompactionEntry): Promise<void> {
    const checked = compactionEntrySchema.parse(entry);
    buildContext([...this.entries, checked]);
    await this.appendEntry(checked);
  }

  async appendCheckpoint(
    next: CheckpointEntry["next"],
    turns: number,
    maxTurns: number,
  ): Promise<void> {
    const previous = this.entries.at(-1);
    if (previous === undefined) {
      throw new Error("没有历史记录，不能创建检查点");
    }
    const entry = checkpointEntrySchema.parse({
      type: "checkpoint",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: this.id,
      afterEntryId: previous.id,
      next, turns, maxTurns,
    });
    inspectRecovery([...this.entries, entry], this.id);
    await this.appendEntry(entry);
  }

  private async appendEntry(entry: SessionEntry): Promise<void> {
    if (this.failed) {
      throw new Error("会话之前保存失败，请检查文件后重新加载，不能直接重试追加");
    }
    if (this.writing) {
      throw new Error("会话正在写入，必须等待上一次追加结束");
    }
    if (entry.id === this.header.id || this.entries.some((item) => item.id === entry.id)) {
      throw new Error(`记录 ID 重复：${entry.id}`);
    }
    this.writing = true;
    try {
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

appendCheckpoint 先取当前末条记录，再创建指向它的新记录。`CheckpointEntry["next"]` 是 TypeScript 的索引访问类型，表示取 CheckpointEntry 中 next 字段的类型，也就是 `"model" | "input"`，没有创建新的对象。

候选先经 schema 和 inspectRecovery 校验，再进入 appendEntry。只有文件追加成功，entries 才更新。保存订阅者先注册，所以 CLI 打印 `[checkpoint]` 时，相应追加已经成功返回；这仍不等于断电后一定持久存在。

load 先检查版本、行完整性、ID、cwd，再检查 checkpoint 与完整上下文。发生任何失败直接抛错，不偷偷创建新会话。

本章仍是单进程写文件：writing 只能防同一对象的并发追加，不能阻止另一个进程写同一 JSONL。检查点、消息、文件副作用没有跨资源事务；也没有 fsync、进程锁或远程执行幂等键。

## 7. src/events.ts：把稳定位置表达为事件

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
  | {
      type: "run_boundary";
      next: "model" | "input";
      turns: number;
      maxTurns: number;
    }
  | AgentEndEvent;

export type EventListener = (event: AgentEvent) => void | Promise<void>;
export type EmitEvent = (event: AgentEvent) => Promise<void>;
```

run_boundary 不是新的 RunResult。主循环仍返回 completed 或 stopped，取消和错误仍抛异常。它只是要求保存层在继续执行前记录 next、turns 和 maxTurns。

agent_end 不承担检查点保存：它也会在错误、取消等不完整位置出现。不能在 finally 中一律保存“可以继续”，否则会把不确定的状态写成有效恢复点。

## 8. src/agent-loop.ts：恢复从下一轮开始

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
  completedTurns: number = 0,
): Promise<RunResult> {
  for (let turn = completedTurns + 1; turn <= maxTurns; turn += 1) {
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
        await emit({ type: "run_boundary", next: "input", turns: turn, maxTurns });
        return { status: "stopped", reason: reason, turns: turn };
      }
    }

    if (calls.length === 0) {
      await emit({ type: "run_boundary", next: "input", turns: turn, maxTurns });
      return { status: "completed", answer: response.text, turns: turn };
    }
    // 最大轮数耗尽时只能接收新任务；恢复不能偷偷获得额外轮数。
    const next = turn < maxTurns ? "model" : "input";
    await emit({ type: "run_boundary", next, turns: turn, maxTurns });
    signal.throwIfAborted();
  }

  throw new Error(`已达到 ${maxTurns} 次模型请求的上限，本次任务尚未得到最终回答`);
}
```

新增参数 `completedTurns = 0`：新任务默认从 1 开始，恢复传 2 就从 3 开始。for 循环仍以原 maxTurns 为上限。

run_boundary 的 next 由实际控制流决定：

| 当前分支 | next | 本次运行结果 |
| --- | --- | --- |
| afterTurn 要求停止 | input | stopped |
| 没有工具调用，已有最终回答 | input | completed |
| 已完成工具批次，仍有额度 | model | 进入下一轮 |
| 完成最后允许的一轮，仍需模型继续 | input | 抛轮数上限错误 |

afterTurn 处理完才保存检查点，因此恢复不会再次调用上一轮的 afterTurn。若进程在 Hook 中退出，通常已有新消息位于旧检查点之后，恢复会拒绝猜测它的处理结果。Hook 本身若有外部副作用，仍需要独立的幂等设计；本章的 Hook 只按前几章约定参与策略与观察。

取消发生在批次中时，保留原来的尽量补齐结果行为，但批次后的取消检查会阻止写新检查点。即使结果恰好已配齐，只要没有新的稳定点，也会拒绝自动恢复。这是第一版的保守边界。

## 9. src/agent.ts：prompt 和 resume 复用相同运行过程

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

  getTurnLimit(): number {
    return this.maxTurns;
  }

  prompt(input: string, prepareContext: PrepareContext): Promise<RunResult> {
    return this.run(input, prepareContext, 0, this.maxTurns);
  }

  resume(
    prepareContext: PrepareContext,
    completedTurns: number,
    maxTurns: number,
  ): Promise<RunResult> {
    return this.run(undefined, prepareContext, completedTurns, maxTurns);
  }

  private async run(
    input: string | undefined,
    prepareContext: PrepareContext,
    completedTurns: number,
    maxTurns: number,
  ): Promise<RunResult> {
    if (this.controller !== undefined) {
      throw new Error("Agent 正在运行，请等待结束后再提交输入");
    }
    if (this.deliveryFailed) {
      throw new Error("之前的事件通知失败，状态可能未保存完整，请新建 Agent 后重试");
    }
    if (!Number.isInteger(completedTurns) || completedTurns < 0 ||
        !Number.isInteger(maxTurns) || maxTurns < 1 || completedTurns >= maxTurns) {
      throw new Error("恢复轮数无效或任务已经达到上限");
    }
    if (input !== undefined && input.trim() === "") {
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
      if (input !== undefined) {
        await this.emit({ type: "message_end", message: new HumanMessage(input) });
      }
      const result = await runLoop(
        prepareContext,
        this.model,
        this.tools,
        this.hooks,
        this.cwd,
        maxTurns,
        controller.signal,
        (event) => this.emit(event),
        completedTurns,
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

新增的 private run 把以前 prompt 的共同流程保留在一个地方：

```text
prompt("读取文件")
  → run(input="读取文件", completedTurns=0, maxTurns=当前配置)
  → 保存 HumanMessage → runLoop

resume(...)
  → run(input=undefined, completedTurns=检查点轮数, maxTurns=检查点上限)
  → 不创建 HumanMessage → runLoop
```

undefined 在这里表示“没有新的用户输入”，不是空字符串。空字符串仍是无效新任务。

恢复会创建新的 AbortController；取消信号不从磁盘恢复。事件订阅、工具函数、Hook、模型由当前进程重新组装，消息由 Session 恢复。直接 Agent.resume 只检查运行参数，**磁盘恢复必须走 AgentSession.resume**，因为检查点验证属于上层。

getTurnLimit 让新建 Session 能把初始轮数限制写入检查点。恢复时使用记录中的限制；新任务才使用当前配置。

## 10. src/agent-session.ts：保存稳定点，并限制两个入口

<!-- file: src/agent-session.ts -->
```ts
import type { BaseMessage } from "@langchain/core/messages";
import type { Budget } from "./budget.ts";
import { prepareCompaction } from "./compact.ts";
import type { ModelIO } from "./model-io.ts";
import type { Agent } from "./agent.ts";
import { inspectRecovery } from "./checkpoint.ts";
import { buildContext } from "./context.ts";
import type { EventListener, RunResult } from "./events.ts";
import { SessionManager } from "./session-manager.ts";

export class AgentSession {
  private agent: Agent;
  private manager: SessionManager;
  private model: ModelIO;
  private budget: Budget;

  private constructor(agent: Agent, manager: SessionManager, model: ModelIO, budget: Budget) {
    this.agent = agent;
    this.manager = manager;
    this.model = model;
    this.budget = budget;
    this.agent.subscribe(async (event) => {
      if (event.type === "message_end") {
        await this.manager.appendMessage(event.message);
      } else if (event.type === "run_boundary") {
        await this.manager.appendCheckpoint(event.next, event.turns, event.maxTurns);
      }
    });
  }

  static async create(agent: Agent, cwd: string, model: ModelIO, budget: Budget): Promise<AgentSession> {
    const manager = await SessionManager.create(cwd, agent.getMessages());
    await manager.appendCheckpoint("input", 0, agent.getTurnLimit());
    return new AgentSession(agent, manager, model, budget);
  }

  static async load(agent: Agent, cwd: string, filePath: string, model: ModelIO, budget: Budget): Promise<AgentSession> {
    const manager = await SessionManager.load(filePath, cwd);
    try {
      agent.replaceMessages(manager.getMessages());
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`无法继续会话 ${manager.filePath}：${detail}。不会重放工具或删除记录`, {
        cause: error,
      });
    }
    return new AgentSession(agent, manager, model, budget);
  }

  get filePath(): string {
    return this.manager.filePath;
  }

  get id(): string {
    return this.manager.id;
  }

  private async prepareContext(signal: AbortSignal): Promise<BaseMessage[]> {
    const entry = await prepareCompaction(
      this.manager.getEntries(), this.model, this.budget, signal,
    );
    signal.throwIfAborted();
    if (entry !== undefined) {
      // 保存错误不能当作摘要失败忽略。写失败后 Manager 会拒绝继续追加。
      await this.manager.appendCompaction(entry);
      console.error(`[compact] 估算 ${entry.tokensBefore} → ${entry.tokensAfter}`);
    }
    return buildContext(this.manager.getEntries());
  }

  async prompt(input: string): Promise<RunResult> {
    const checkpoint = inspectRecovery(this.manager.getEntries(), this.id);
    if (checkpoint.next !== "input") {
      throw new Error("已有任务等待恢复，请使用 --resume，不追加新的 HumanMessage");
    }
    return this.agent.prompt(input, (signal) => this.prepareContext(signal));
  }

  async resume(): Promise<RunResult> {
    const checkpoint = inspectRecovery(this.manager.getEntries(), this.id);
    if (checkpoint.next !== "model") {
      throw new Error("会话正在等待新输入；请使用 --session <路径> <新问题>");
    }
    return await this.agent.resume(
      (signal) => this.prepareContext(signal),
      checkpoint.turns,
      checkpoint.maxTurns,
    );
  }

  abort(): void {
    this.agent.abort();
  }

  subscribe(listener: EventListener): () => void {
    return this.agent.subscribe(listener);
  }
}
```

新建会话先保存初始系统消息，再保存 `input, turns=0` 检查点。如果第二次写入失败，文件可能只有初始消息，加载时就会报告缺少检查点，不会猜测创建过程成功。

订阅者现在处理两类事件：message_end 保存消息；run_boundary 保存检查点。压缩仍在 prepareContext 中协调，不作为原始消息保存。

恢复完整调用链：

```text
CLI --resume 文件
  → createSession → Manager.load
      → JSONL / schema / cwd / ID
      → inspectRecovery
      → buildContext 检查有效上下文
  → Agent.replaceMessages 装入全部原始消息
  → session.resume 再确认 next=model
  → agent.resume → 新的 controller
  → Loop 从 checkpoint.turns + 1 开始
      → prepareContext：必要时压缩，然后重建
      → beforeModel → model.request
      → 新产生的消息继续追加
```

prepareContext 若在旧检查点后保存了一条 compaction，随后进程退出，该尾部也会阻止自动恢复。允许特定纯元数据尾部是未来可以加入的能力；本章选择统一拒绝，避免暗中回退状态。

## 11. src/cli.ts：明确选择新问题或恢复任务

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
    case "run_boundary":
      console.error(`[checkpoint] 下一步 ${event.next}，已完成 ${event.turns}/${event.maxTurns} 轮`);
      break;
    case "agent_end":
      console.error(`[agent_end] ${event.status}：${event.detail}`);
      break;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let filePath: string | undefined;
  let resume = false;
  if (args[0] === "--resume" || args[0] === "--session") {
    resume = args[0] === "--resume";
    filePath = args[1];
    if (filePath === undefined || filePath.trim() === "" || filePath.startsWith("--")) {
      throw new Error("选项后面需要会话文件路径");
    }
    args.splice(0, 2);
    if (resume && args.length !== 0) {
      throw new Error("--resume 只恢复原任务，不能同时提交新问题");
    }
  } else if (args[0]?.startsWith("--")) {
    throw new Error(`未知选项：${args[0]}`);
  }
  const input = args.join(" ").trim();
  if (!resume && input === "") {
    console.log('新建：npm start -- "读取 package.json，说明项目依赖"');
    console.log('新问题：npm start -- --session ".alpha/sessions/<会话ID>.jsonl" "继续讨论"');
    console.log('恢复任务：npm start -- --resume ".alpha/sessions/<会话ID>.jsonl"');
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
    const result = resume ? await session.resume() : await session.prompt(input);
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

参数只支持开头的一种模式，不实现通用选项解析器：

```text
npm start -- "新任务"
npm start -- --session <文件> "新问题"
npm start -- --resume <文件>
```

`--resume` 后不能跟新问题；等待输入的会话也不能 resume。next=model 的会话必须恢复原任务，不能通过 --session 偷偷插入新的 HumanMessage。

退出码沿用前面章节：正常 0、策略停止 2、普通错误 1、任务期间收到 SIGINT 并取消失败退出时 130。模型已经产出了最终回答但进程在打印前退出时，末尾若是 input 检查点，就等待新输入；本章不把已保存答案自动重印为一次新回答。

## 12. 运行与人工核对

先按顺序保存 Step 1 → Step 7 的最新完整文件。下面真实任务会读取 .env、调用模型；这里只提供人工步骤，没有增加测试文件、mock 或内联断言。

```sh
cd /Users/jquery/ts_files/alpha
npm run check
npm start
```

### 12.1 正常完成后等待新问题

新建本章 version: 3 会话：

```sh
ALPHA_READ_ONLY=1 ALPHA_STOP_AFTER_TURN=0 npm start -- "请调用 read 读取 package.json，然后说明 dependencies。"
```

用日志中的真实路径查看 JSONL。初始系统消息后应有 turns=0 的 input 检查点；如果确实调用 read，会在工具结果和策略处理之后看到 model 检查点；最终回答之后应有 input 检查点。

```sh
cat ".alpha/sessions/<会话ID>.jsonl"
npm start -- --session ".alpha/sessions/<会话ID>.jsonl" "根据刚才读到的内容，只列出依赖名称。"
```

第二次运行追加一个新的 HumanMessage，任务轮数从 1 开始。对这个已经完成的会话运行 --resume，应报“等待新输入”，不再请求模型。

### 12.2 从完整工具批次恢复

为了准确观察稳定位置，可以使用编辑器的 Node 调试器，不靠抢时间中断，也不改实现加入专门的测试分支：

1. 在 agent-loop.ts 的普通工具分支 `await emit({ type: "run_boundary", next, ... })` **完成后的** `signal.throwIfAborted()` 处设断点。
2. 启动新的只读任务，要求读取 package.json。确认实际有 read 事件，且 next 为 model；让进程在该断点暂停。
3. 在另一个终端只读查看文件，确认完整 ToolMessage 已保存，末条是 next=model 的检查点，turns=1。
4. 终止这个调试进程，确认它已经退出。不要让两个进程同时使用同一会话。
5. 使用真实路径运行：

```sh
ALPHA_READ_ONLY=1 ALPHA_STOP_AFTER_TURN=0 ALPHA_DEBUG_CONTEXT=1 npm start -- --resume ".alpha/sessions/<会话ID>.jsonl"
```

观察恢复后的请求包含已保存的工具结果，没有额外 HumanMessage，轮数从 2 开始。恢复代码不直接调用之前的 read；如果模型又提出一个新的 read，应通过新 AIMessage 和调用 ID 区分，这是模型新决策，不是旧调用重放。

此处不要用 `ALPHA_STOP_AFTER_TURN=1` 代替断点：这个 Hook 表示策略停止，会写 next=input，因此随后只能发新问题，不能恢复为继续模型。

### 12.3 中断位置不明确时停止

用只读任务即可观察不确定尾部，无需实际执行危险命令：在 AI 工具调用消息已保存、执行工具前暂停，再终止进程。文件中旧检查点后会多出 AIMessage。

重新加载应指出尾部记录，拒绝自动恢复；不能补造失败 ToolMessage，也不能删掉 AIMessage 重跑。即使这次暂停得很早、你知道工具还没运行，程序只凭文件也不会推断这一点。

### 12.4 其他边界

| 情况 | 预期行为 |
| --- | --- |
| checkpoint 后有完整工具结果，但没有新 checkpoint | 仍拒绝猜测 |
| checkpoint 后只有 compaction | 保守拒绝，不忽略 |
| sessionId / afterEntryId 错误、轮数不符 | 校验失败 |
| 旧版本、半行 JSON、重复 ID、不同 cwd | 加载失败 |
| 原任务已用完轮数 | input 检查点；--resume 不能增加额度 |
| 检查点写入失败 | 当前运行停止；是否可加载取决于真实文件尾 |
| 取消发生在稳定点前 | 不强行写可恢复状态 |
| 工作区文件在进程退出后被改动 | 不回滚、不验证文件快照，恢复用当前工作区 |

这些条件需要分别取得运行证据。讨论错误数据时应使用独立副本；本章没有自动修复、删除尾部或回滚文件的命令。

## 13. 学完后应该能解释

1. Session、Context、Compact、Checkpoint 各保存或构造什么？
2. 为什么只有工具结果还不够，还要等 afterTurn 做出决定？
3. 恢复为什么不能再追加原来的 HumanMessage？
4. afterEntryId、firstKeptEntryId 和 tool_call_id 分别指向什么？
5. 为什么 resume 必须继承旧轮数上限？
6. 为什么检查点后的一条新 AIMessage 会让自动恢复停止？
7. 为什么完整结果后的尾部也可能被本章拒绝？
8. 为什么不能通过重放工具来判断它上次有没有执行？
9. 新进程重新创建哪些对象，哪些数据从 JSONL 恢复？
10. 为什么这个实现不等于工作区回滚或生产级崩溃恢复？

至此，教程主线可以从 CLI 追到 Session、Agent、Loop、工具，再回到消息保存、上下文压缩与稳定位置恢复。后续增强应针对具体需求加入，例如精确 tokenizer、任务内部切分、恢复尾部分析、文件锁、工具幂等性和工作区快照。

## 14. 本章验证范围

2026-10-20 的验证结果：

- 在另一个独立临时目录按 Step 1 → Step 7 顺序提取完整文件代码块，前六章沿用对应版本，第七章覆盖 8 个文件，最终组成 22 个 TypeScript 源码文件。
- 使用 Alpha 已安装的依赖和 Node.js 26.7.0，运行临时项目的 `npm run check`，退出码为 0，无类型错误；没有安装或升级依赖。
- 无参数 `npm start` 正确打印新建、新问题、恢复任务三种用法，退出码为 0。
- `npm start -- --resume` 缺少路径，以及 `--resume example.jsonl "额外问题"`，均在读取会话或调用模型前报参数错误，退出码为 1。
- 临时目录没有 .env；移除模型相关环境变量后带任务启动，正确报告缺少 OPENAI_API_KEY，退出码为 1，没有发起模型请求或创建会话。
- 文档本地链接均存在；Alpha 原有 src 与已有教程的内容哈希未变。本次只新增 step6.md 和 step7.md，没有新增或修改测试文件、mock 或断言脚本。
- 未实际执行检查点落盘、跨进程恢复、真实工具循环、最大轮数恢复、文件损坏、写盘失败或取消场景。这里的验证证明代码组合通过静态检查、基本 CLI 分支可运行，不代表崩溃恢复已经经过端到端验证；第 12 节列出了人工验收方法。
