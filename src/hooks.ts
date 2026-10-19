import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from "@langchain/core/messages";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";

export type MaybePromise<T> = T | Promise<T>;
export type ToolStatus = "success" | "error" | "denied";


export type ToolHookCall = {
  id:string;
  name:string;
  args:unknown;
  cwd:string;
};

export type ToolHookResult = {
  id:string;
  name:string;
  status:ToolStatus;
  raw:string;
  content:string;
};

export type TurnInfo = {
  turn:number;
  toolCount:number;
  hasAnswer:boolean;
};

export type Hook = {
  beforeModel?:(
    messages:BaseMessage[],
    signal:AbortSignal,
  ) => MaybePromise<BaseMessage[] | void>;
  afterModel?:(
    message:AIMessage,
    signal:AbortSignal,
  ) => MaybePromise<void>;
  beforeTool?:(
    call:ToolHookCall,
    signal:AbortSignal,
  ) => MaybePromise<string|void>;
  afterTool?:(
    result:ToolHookResult,
    signal:AbortSignal,
  ) => MaybePromise<string|void>;
  afterTurn?:(
    turn:TurnInfo,
    signal:AbortSignal,
  ) => MaybePromise<string|void>;
};

export function copyMessages(messages:BaseMessage[]):BaseMessage[] {
  const sorted = mapChatMessagesToStoredMessages(messages);
  const cpoied = structuredClone(sorted);
  return mapStoredMessagesToChatMessages(cpoied)
}



