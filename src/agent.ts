import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { runLoop } from "./agent-loop.ts";
import type { AgentEndEvent, AgentEvent, EventListener, RunResult } from "./events.ts";
import { copyMessages } from "./hooks.ts";
import type { PrepareContext } from "./agent-loop.ts";
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
    if (event.type === "message_end"){
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