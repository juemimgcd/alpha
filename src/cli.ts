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