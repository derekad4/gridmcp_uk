import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const apiHealthChecks = pgTable("api_health_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  target: text("target").notNull(),
  slotAt: timestamp("slot_at", { withTimezone: true }).notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  source: text("source").notNull(),
  status: text("status").notNull(),
  responseMs: integer("response_ms"),
  httpStatus: integer("http_status"),
  reason: text("reason").notNull(),
}, (t) => [
  uniqueIndex("api_health_slot_unique").on(t.target, t.slotAt, t.source),
  index("api_health_time_idx").on(t.checkedAt),
  index("api_health_target_time_idx").on(t.source, t.target, t.checkedAt),
]);
export const insertApiHealthCheckSchema = createInsertSchema(apiHealthChecks).omit({ id: true });
export type ApiHealthCheck = typeof apiHealthChecks.$inferSelect;
