import { pgTable, text, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// Separate namespaces prevent simulations or opt-out periods mutating live incidents.
export const apiMonitorAlertState = pgTable("api_monitor_alert_state", {
  namespace: text("namespace").primaryKey(),
  state: jsonb("state").notNull(),
  watchdogAt: timestamp("watchdog_at", { withTimezone: true }),
});
export const insertApiMonitorAlertStateSchema = createInsertSchema(apiMonitorAlertState);
export type ApiMonitorAlertState = typeof apiMonitorAlertState.$inferSelect;

export const apiMonitorAlertEvents = pgTable("api_monitor_alert_events", {
  id: text("id").primaryKey(),
  namespace: text("namespace").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
});
export const insertApiMonitorAlertEventSchema = createInsertSchema(apiMonitorAlertEvents);
export type ApiMonitorAlertEvent = typeof apiMonitorAlertEvents.$inferSelect;
