export type AlertMode = "disabled" | "dry-run" | "live" | "misconfigured";
export function alertConfig(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.MONITOR_EMAIL_ENABLED === "true";
  const dryRun = env.MONITOR_EMAIL_DRY_RUN !== "false";
  const from = env.MONITOR_EMAIL_FROM?.trim() ?? "";
  const to = env.MONITOR_EMAIL_TO?.trim() ?? "";
  const valid = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  const configured = valid.test(from) && valid.test(to);
  const mode: AlertMode = !enabled ? "disabled" : dryRun ? "dry-run" : configured ? "live" : "misconfigured";
  return { mode, from, to };
}
