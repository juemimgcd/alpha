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

export const compactionEntrySchema = z.object({
  type: z.literal("compaction"),
  id: z.uuid(),
  timestamp: z.iso.datetime(),
  summary: z.string().trim().min(1).max(12000),
  firstKeptEntryId: z.uuid(),
  tokensBefore: z.number().int().nonnegative(),
  tokensAfter: z.number().int().nonnegative(),
});

export const sessionRecordSchema = z.discriminatedUnion("type", [
  sessionHeaderSchema,
  messageEntrySchema,
  compactionEntrySchema,
]);

export type SessionHeader = z.infer<typeof sessionHeaderSchema>;
export type MessageEntry = z.infer<typeof messageEntrySchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export type CompactionEntry = z.infer<typeof compactionEntrySchema>;
export type SessionEntry = MessageEntry | CompactionEntry;



