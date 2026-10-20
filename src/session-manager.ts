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
      type:"sessoin",
      version:1,
      id:randomUUID(),
      timestamp:new Date().toISOString(),
      cwd:root,
    });
    const entries:MessageEntry[] = [];
    for (const message of messages){
      entries.push(messageEntrySchema.parse({
        type:"message",
        id:randomUUID(),
        timestamp:new Date().toDateString(),
        message:encodeMessage(message),
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

    for (let index =0; index < lines.length; index++){
      try{
        let raw:unknown = JSON.parse(lines[index]);
        const record = sessionRecordSchema.parse(raw);
        if (ids.has(record.id)){
          throw new Error();
        }
        ids.add(record.id);

        if (index === 0){
          if (record.type !== "session"){
            throw new Error();
          }
          if (record.cwd !== root){
            throw new Error();
          }
          header = record;
        }else {
          if (record.type !== "message") {
            throw new Error("头部之后只能出现 message 记录");
          }
          entries.push(record);
        }
      }catch(error:unknown){
        const detail = error instanceof Error ? error.message:String(error);
        throw new Error(`${absolutePath}:${index + 1}：${detail}`, { cause: error });
      }
    }
    if (header == undefined){
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
    try{
      const entry = messageEntrySchema.parse({
        type:"message",
        id:randomUUID(),
        timestamp:new Date().toISOString(),
        message:encodeMessage(message),
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