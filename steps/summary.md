# Alpha：模仿 pi1 的 TypeScript Coding Agent Demo

## 1. 项目定位

Alpha 是一个模仿 **pi1** 核心工作方式的 coding agent demo，也是从 TypeScript 基础学习走向 Agent 开发的实践项目。

本项目的参照是已经讨论过的 pi coding-agent 主线：`AgentSession → Agent → agent-loop`，以及与它协作的工具、会话记录、上下文和压缩功能。本文沿用“pi1”作为这个参照的称呼，不把它解释为已经核实的版本号，也不混入仓库中另一套 `harness` 的运行状态机。

目标是能读文件、改文件、执行命令、持续调用工具，并逐步具备 Hook、会话保存、上下文管理、压缩和恢复能力。实现时保留 pi 的核心职责关系，缩小功能范围，把代码写成 TS 初学者能够逐行追踪的形式。

**当前状态：本文是架构与实现路线约定，不代表这些功能已经完成。** 下文目录中的源码文件均为计划结构。

## 2. 技术边界

| 部分 | 使用什么 | 负责什么 |
| --- | --- | --- |
| 一次模型请求 | LangChain 模型适配器 | 配置模型、发送请求、返回响应；后续接入流式输出 |
| 消息表示 | LangChain 消息类型 | `SystemMessage`、`HumanMessage`、`AIMessage`、`ToolMessage` 等 |
| 运行时数据校验 | Zod | 检查工具参数、配置和读取的会话数据 |
| Agent 行为 | 手写 TypeScript | loop、tool 调度、hook、session、context、compact、checkpoint |
| 本地操作 | Node.js 内置模块 | 文件读写、路径处理、子进程、终端输入输出 |

LangChain 可以负责向模型声明工具，但**什么时候执行工具、执行哪个本地函数、如何处理结果、是否继续请求模型，都由 Alpha 决定**。不使用现成 Agent executor 或 LangGraph 来接管这些流程。

消息直接使用 LangChain 提供的对象，不额外创造一套平行的 `AlphaHumanMessage`、`AlphaAIMessage`。持久化时集中处理消息编码和恢复；不能把 `JSON.parse()` 得到的普通对象直接断言成消息实例。

会话记录可以在消息外包一层 ID、时间等元数据。消息类型和会话记录类型承担不同职责。

## 3. TypeScript 写法约定

以 [frontend 学习路线](/Users/jquery/frontend/days/summary.md) 为语法基础。Day 8 的工具注册和 Day 9 的异步调度可以直接衔接本项目。

- 优先使用普通函数、普通对象、`type`、`interface` 和简单的类。
- 使用 `if`、`switch`、`for...of`、`async/await` 明确展示顺序。
- 类的字段和构造函数赋值展开写，能直接看出对象保存了什么。
- 先用组合：一个对象持有另一个对象并调用它。初期不设计多层 Runtime 继承体系。
- 初期避免复杂泛型、条件类型、装饰器、通用注册框架和多层工厂。
- 不用 `any` 或大量 `as` 绕过问题；外部数据先作为 `unknown` 接收，再检查。
- 允许少量直白重复，出现实际维护问题后再抽取公共逻辑。
- 第一次出现新语法时，解释它的输入、返回值、调用者和执行时机。
- 保持类型检查严格。简化表达方式，不省略必要的数据检查与错误处理。

每一步都按“要解决的问题 → 小例子 → 调用过程 → 完整实现 → 手动验证”的顺序展开，不先堆一套空接口或抽象骨架。

## 4. 整体架构

```text
CLI：读取用户输入，展示回答与工具进度
  │
  └─ AgentSession：协调一段 coding 会话
       │
       ├─ SessionManager：追加、保存、加载会话记录
       ├─ Context：从记录构造本轮模型输入
       ├─ Compact：选择压缩范围，调用模型生成摘要
       ├─ Checkpoint：记录稳定的运行位置，判断如何恢复
       │
       └─ Agent：保存运行状态，提供 prompt / abort / subscribe
            │
            └─ Loop：按顺序推动一次 Agent 运行
                 ├─ ModelIO → LangChain → 模型
                 ├─ Dispatch → Zod → 本地 Tool
                 └─ 在明确位置调用 Hook，并发出事件
```

这是职责图，不要求每一块都是一个类。`Agent`、`AgentSession`、`SessionManager` 适合保存状态；Loop、Context、Compact 等优先写成普通函数。

### 4.1 AgentSession：协调会话

对外提供一次任务的入口，例如 `session.prompt("读取 README，解释项目")`。

它负责准备输入、连接 Hook、接收 Agent 事件并保存消息，协调上下文压缩和恢复。它持有 `Agent` 和 `SessionManager`，不继承 `Agent`。

### 4.2 Agent：管理当前运行

保存当前有效消息、工具、是否正在运行、取消信号等状态。`prompt()` 启动 Loop，`abort()` 请求取消，`subscribe()` 允许上层接收事件。

Agent 不直接负责会话文件读写。它的消息是当前运行需要的消息，不一定等于磁盘上的全部历史记录。

### 4.3 Loop：决定下一步

Loop 负责请求模型、处理工具调用、进入下一轮或结束。它调用其他模块完成具体操作，不把文件保存、摘要提示词、CLI 显示都塞进循环体。

### 4.4 事件：连接运行、保存和显示

第一版事件保持少量、明确，例如：

- `message_end`：一条完整消息已经产生。
- `tool_start` / `tool_end`：一次工具执行开始或结束。
- `turn_end`：一次模型响应及其工具结果已经处理完毕。
- `agent_end`：这次循环不再继续。

这些是 Alpha 的拟定名称，不要求与 pi 的事件名完全相同。

关键顺序是：消息完成 → Agent 更新状态 → AgentSession 保存记录 → 再继续后续阶段。涉及保存的异步回调必须 `await`；保存失败应明确结束本次运行，不能静默假装已经保存。

Hook 用来参与决策或修改允许修改的数据；事件用来通知状态变化。两者不要混成一个可以任意改写状态的大接口。

## 5. 计划目录

```text
alpha/
├─ package.json
├─ tsconfig.json
├─ .gitignore
├─ steps/
│  ├─ summary.md          # 当前文档：整体架构与实现路线
│  ├─ step1.md            # 模型、消息、read 工具与最小 loop
│  ├─ step2.md            # coding 工具与统一调度
│  ├─ step3.md            # Hook 与事件
│  ├─ step4.md            # Session 保存与加载
│  ├─ step5.md            # Context 构造
│  ├─ step6.md            # Compact
│  └─ step7.md            # Checkpoint 与恢复
├─ src/
│  ├─ cli.ts              # 终端交互
│  ├─ app.ts              # 创建模型、工具、Agent 和 AgentSession
│  ├─ model-io.ts         # 薄薄的 LangChain 模型调用层
│  ├─ agent.ts            # Agent 状态与运行入口
│  ├─ agent-loop.ts       # 循环顺序与结束条件
│  ├─ agent-session.ts    # 会话协调
│  ├─ events.ts           # 少量事件类型
│  ├─ hooks.ts            # Hook 类型与直接调用
│  ├─ protocol.ts         # 消息和工具调用配对规则
│  ├─ tools.ts            # 工具契约与工具集合
│  ├─ dispatch.ts         # 查找、校验、执行、封装工具结果
│  ├─ session-manager.ts  # 会话记录追加与文件存取
│  ├─ session-types.ts    # 消息记录、压缩记录、检查点记录
│  ├─ message-codec.ts    # LangChain 消息的保存与恢复
│  ├─ context.ts          # 构造本轮模型消息
│  ├─ compact.ts          # 压缩准备与摘要生成
│  ├─ checkpoint.ts       # 检查点保存条件与恢复判断
│  └─ builtin-tools/
│     ├─ read.ts
│     ├─ write.ts
│     ├─ edit.ts
│     └─ bash.ts
└─ .alpha/
   └─ sessions/           # 本地会话数据，加入 gitignore
```

目录展示最终职责位置，不要求第一步把全部文件建出来。第一次出现相应能力时再创建文件；不为预想中的扩展提前建立空壳。

## 6. 从 Loop 到 Checkpoint 的实现约定

### 6.1 Loop：先跑通两次模型请求

用“读取 README，告诉我怎么启动项目”作为第一条完整任务：

```text
HumanMessage：用户提出任务
  → 准备本轮上下文
  → LangChain 请求模型
  → AIMessage：要求调用 read，带调用 ID 和参数
  → 保存 AIMessage
  → 校验参数并读取文件
  → ToolMessage：带对应的 tool_call_id
  → 保存 ToolMessage
  → 再次请求模型
  → AIMessage：解释项目启动方式
  → 结束
```

模型提出调用要求，本地程序执行工具，下一次请求才把结果交给模型。

第一版使用非流式响应、串行工具执行、明确的最大轮数和取消信号。没有工具调用且响应有效时正常结束；达到上限、请求失败或取消时，应能分辨结束原因。

本文的“一轮”是一次主模型请求及其产生的整批工具执行；一次用户任务可以包含多轮。压缩摘要请求不计作主循环的一轮。

`protocol.ts` 集中定义新响应是否可接纳、调用 ID 是否有效、发出的消息是否正确配对等规则。在接收响应和发送请求的相应边界调用，不在 Hook、Session、每个 Tool 中重复整套校验。

### 6.2 Tool：沿用 pi 的工具组织方式

每个工具包含名称、说明、Zod 参数 schema 和执行函数。模型能看到工具说明与参数结构，本地执行函数留在程序中。

`dispatch.ts` 的顺序明确写出：

```text
按名称查找工具
  → 用该工具的 Zod schema 校验一次参数
  → beforeTool
  → 执行工具
  → afterTool
  → 构造对应的 ToolMessage
```

先实现 `read`，再加入 `write`、`edit`、`bash`。读取大文件和命令输出需要长度限制；执行命令需要工作目录、超时和取消处理。初期串行执行，避免“写入”和“读取”同时发生时难以解释结果。

未知工具、参数错误、Hook 拒绝和工具执行失败都要有明确结果，不能返回空字符串冒充成功。适合交给模型修正的工具错误，作为对应的工具结果返回；会话保存失败等基础设施错误应终止运行。

### 6.3 Hook：保留位置，写法直接

参考 pi 的工具前后回调和请求前上下文调整，Alpha 先支持少量明确的回调，例如 `beforeModel`、`afterModel`、`beforeTool`、`afterTool`、`afterTurn`。

Hook 使用普通对象保存，使用 `for...of` 按注册顺序调用并等待。初期不做复杂的事件名称泛型、插件自动发现和动态加载。

每个回调的权限分别约定：

| 回调 | 初期职责 |
| --- | --- |
| `beforeModel` | 调整本轮请求的消息副本，调整后检查消息配对 |
| `afterModel` | 观察完整模型响应，例如记录耗时；不随意替换工具调用 |
| `beforeTool` | 接收已校验参数，允许或拒绝当前工具调用 |
| `afterTool` | 处理模型将看到的工具结果，例如缩短过长输出 |
| `afterTurn` | 观察这一轮，必要时请求结束运行 |

拒绝当前工具和停止整个 Agent 是不同动作。工具调用 ID、工具名称等配对信息由调度器维护，不能被结果处理 Hook 改掉。具体返回类型在实现该步骤时逐项定义，不用一个包揽全部情况的复杂返回对象。

### 6.4 Session：保存发生过什么

参考 pi 的追加式会话记录，先用 JSONL 文件：每一行是一条 JSON 记录。初期只支持一条线性的会话历史，后续需要分支时再引入对应逻辑。

会话记录从必要种类开始：消息、压缩、检查点。消息记录带记录 ID、时间和可恢复的消息数据；可执行工具函数不保存进 JSON。

`AgentSession` 决定什么时候追加，`SessionManager` 完成文件存取，`message-codec.ts` 集中完成消息编码与恢复。磁盘数据用 Zod 检查，损坏或不支持的数据要明确报告。

先实现“退出程序后重新加载会话并继续对话”。这与“工具执行到一半崩溃后自动续跑”不是同一项能力，后者在 Checkpoint 步骤中讨论。

### 6.5 Context：决定这一次模型看到什么

保留 pi 的核心分工：完整会话记录是历史依据，本轮模型消息是从记录构造出来的结果。

最初的 Context 只做“系统提示 + 有效会话消息”。加入压缩后，再做“系统提示 + 最新摘要 + 保留的近期消息 + 压缩后新增消息”。

这里优先使用 `buildContext(...)` 这样的普通函数，不强制创建 `Context` 类。构造输入时不直接破坏原始历史；工具调用及其结果不能只保留一半。

Context 函数可以先保持同步；调用它的请求准备过程需要允许 `await`，因为后续可能先执行压缩或加载会话。

### 6.6 Compact：缩短上下文，保留原始记录

参考 pi 的“准备 → 总结 → 追加压缩记录 → 重建上下文”过程：

1. 判断是否接近上下文预算。
2. 选择要总结的旧消息和保留的近期消息。
3. 通过 LangChain 单独请求模型生成摘要。
4. 检查摘要请求成功，且摘要有效、未被截断。
5. 追加压缩记录，保存摘要及保留消息的起点。
6. 重新构造下一轮模型上下文。

摘要保留用户目标、约束、已完成工作、未完成工作、关键决定和相关文件信息。重复压缩时需要把已有摘要纳入新摘要的输入。

初期只在完整轮次之间压缩，优先按完整轮次选择保留范围，不一开始复刻 pi 的轮次内部切分。压缩失败时保留原状态；若原上下文仍超过预算，则明确停止，不能假装压缩成功继续请求。

会话文件中的旧记录继续保留。Token 估算与模型返回的实际 usage 要区分；压缩前的 usage 不能当成压缩后上下文的大小。

### 6.7 Checkpoint：记录可以继续的位置

这是 Alpha 在 pi1 会话保存思路上增加的教学能力。**不声称它直接复刻了 pi coding-agent 主线中的独立 Checkpoint 类，也不照搬另一套 harness 状态机。**

Checkpoint 保存的是 Agent 的恢复信息，不是整个 JavaScript 对象或函数调用栈。初期只在整批工具结果已经保存、没有待执行工具的稳定位置保存检查点。

最低限度记录：当前会话 ID、对应历史记录位置、下一步是继续请求模型还是等待用户输入，以及必要的轮数信息。上下文通过会话记录和压缩记录重建，不再保存一份需要单独同步的完整历史副本。

恢复流程：

```text
加载并检查会话记录
  → 找到最新有效检查点
  → 检查该点之后是否还有新记录或未完成的工具调用
  → 重建上下文与运行状态
  → 在条件明确时继续请求模型，或等待用户输入
```

必须明确处理三个边界：

- 检查点之后出现的新记录不能静默丢弃，也不能无条件退回旧状态。
- 如果工具可能已经执行，但结果没有保存，不能自动重放写文件或命令。第一版报告中断位置和不确定性，由用户决定下一步。
- 恢复会话不等于恢复工作区文件。文件回滚需要额外的快照或补丁设计，不包含在第一版 Checkpoint 中。

## 7. 实现与学习顺序

| 步骤 | 新增能力 | 这一阶段应能说明并手动验证的行为 |
| --- | --- | --- |
| Step 1 | LangChain 消息、模型请求、read、最小 Loop | 读文件后发起第二次请求，得到基于文件内容的回答 |
| Step 2 | coding 工具与统一调度 | 在练习目录修改文件、运行命令；失败结果能对应回调用 |
| Step 3 | Hook 与事件 | 拒绝一次工具调用；观察消息、工具、轮次的事件顺序 |
| Step 4 | Session | 重启后加载同一会话，恢复消息类型及工具调用关系 |
| Step 5 | Context | 能分别查看保存的历史和实际发给模型的消息 |
| Step 6 | Compact | 旧历史仍在，下一次请求使用摘要与近期消息 |
| Step 7 | Checkpoint | 在稳定位置恢复；对执行结果不明的工具明确停止自动重放 |

这些步骤逐步扩展同一条主线，不每一步重新设计一套 Runtime。最终完成的 demo 应能从 `session.prompt(...)` 一直追踪到模型请求、工具执行、消息保存、压缩和恢复。

类型检查、离线运行、真实模型调用、跨进程恢复分别记录验证结果。类型检查通过不能代替真实工具循环或恢复验证。是否新增测试文件，遵守用户对测试变更的明确授权。

## 8. 第一阶段的范围

第一阶段以单 Agent、本地 CLI、固定工具集合和单条会话历史为主。后续再按实际需要加入流式显示和更多交互。

暂不追求完整 TUI、MCP、多 Agent、远程工具、插件市场、多模型路由、会话树 UI、文件回滚或生产级崩溃恢复。它们不是理解 loop 到 checkpoint 的前提。

## 9. pi 源码参照

以下链接对应本次讨论读取的本地 pi 源码；Alpha 的教学接口和文件划分可以更小，不要求照搬其所有参数与类型。

| 源码 | 阅读目的 |
| --- | --- |
| [sdk.ts](/Users/jquery/python_files/pi/packages/coding-agent/src/core/sdk.ts) | 看 Agent、AgentSession 和其他依赖怎样组装 |
| [agent.ts](/Users/jquery/python_files/pi/packages/agent/src/agent.ts) | 看运行状态、prompt、abort 和事件订阅 |
| [agent-loop.ts](/Users/jquery/python_files/pi/packages/agent/src/agent-loop.ts) | 看请求模型、工具前后回调和继续条件 |
| [agent-session.ts](/Users/jquery/python_files/pi/packages/coding-agent/src/core/agent-session.ts) | 看会话协调、事件保存、上下文刷新和压缩接入 |
| [session-manager.ts](/Users/jquery/python_files/pi/packages/coding-agent/src/core/session-manager.ts) | 看追加式记录与有效上下文构造 |
| [compaction.ts](/Users/jquery/python_files/pi/packages/coding-agent/src/core/compaction/compaction.ts) | 看预算、切分位置、摘要与保留范围 |
| [read.ts](/Users/jquery/python_files/pi/packages/coding-agent/src/core/tools/read.ts) | 看工具 schema、执行函数和输出限制 |

实际接入 LangChain、Zod 时，以 Alpha 安装版本的官方接口和类型定义为准。本文不提前指定未核实的版本号或复杂的库类型签名。
