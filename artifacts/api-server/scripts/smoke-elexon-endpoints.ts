import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runEndpointSmoke } from "../src/lib/endpoint-smoke";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--report" && args[1])) {
    throw new Error("Usage: endpoints:smoke [--report FILE.json]");
  }
  const report = await runEndpointSmoke();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args[1]) {
    await mkdir(dirname(args[1]), { recursive: true });
    await writeFile(args[1], json);
  }
  process.stdout.write(json);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((error) => {
  console.error(`Smoke check could not finish: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
