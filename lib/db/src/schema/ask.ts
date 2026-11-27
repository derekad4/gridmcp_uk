import { pgTable, text, integer, timestamp, jsonb, uuid, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const askUsage = pgTable("ask_usage", {
  key: text("key").primaryKey(),
  requests: integer("requests").notNull().default(0),
  tokens: integer("tokens").notNull().default(0),
});
export const askRuns = pgTable("ask_runs", {
  id: uuid("id").primaryKey(),
  session: text("session").notNull(),
  clientHash: text("client_hash").notNull(),
  question: text("question").notNull(),
  status: text("status").notNull(),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("ask_runs_session_idx").on(t.session), index("ask_runs_expires_idx").on(t.expiresAt)]);
export const insertAskRunSchema = createInsertSchema(askRuns);
export type AskRun = typeof askRuns.$inferSelect;
