import { pool } from "@workspace/db";
import { logger } from "./lib/logger";
import { runMonitorOnce } from "./lib/monitoring/runner";
import { runAlerts } from "./lib/monitoring/alerts";

// One-shot scheduled process. It writes directly to PostgreSQL, so a failed
// monitored web server cannot prevent a successfully running checker logging it.
const watchdog = setTimeout(() => {
  logger.error("Health checker exceeded one minute; exiting so scheduled jobs cannot hang indefinitely.");
  process.exit(1);
}, 60000);
watchdog.unref();
try {
  if (process.argv.includes("--watchdog")) {
    if (process.argv.includes("--verify")) throw new Error("Watchdog and verification modes cannot be combined");
    await runAlerts({ watchdog: true });
    logger.info("Independent checker watchdog finished");
  } else {
    const result = await runMonitorOnce(process.argv.includes("--verify") ? "verification" : "independent");
    logger.info({ skipped: result.skipped, checks: result.checks }, "Independent API health check finished");
  }
} catch {
  logger.error("Independent checker or email delivery failed. Verify monitoring configuration, database/schema access, and the Resend connection. No provider credentials or recipient addresses are logged.");
  process.exitCode = 1;
} finally { await pool.end(); clearTimeout(watchdog); }
