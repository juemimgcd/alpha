import type { BaseMessage } from "@langchain/core/messages";
import type { Budget } from "./budget.ts";
import { prepareCompaction } from "./compact.ts";
import type { ModelIO } from "./model-io.ts";
import type { Agent } from "./agent.ts";
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
      }
    });
  }

  static async create(agent: Agent, cwd: string, model: ModelIO, budget: Budget): Promise<AgentSession> {
    const manager = await SessionManager.create(cwd, agent.getMessages());
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

  prompt(input: string): Promise<RunResult> {
    return this.agent.prompt(input, (signal) => this.prepareContext(signal));
  }

  abort(): void {
    this.agent.abort();
  }

  subscribe(listener: EventListener): () => void {
    return this.agent.subscribe(listener);
  }
}