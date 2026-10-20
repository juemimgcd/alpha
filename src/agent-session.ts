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