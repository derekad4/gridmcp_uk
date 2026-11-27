# Elexon Insights MCP

An independent, read-only MCP server for Elexon's public Great Britain electricity market data, with a connection portal and live tool explorer.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/elexon-mcp run dev` — run the connection portal
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- No Elexon API key is needed. Ask Elexon requires the existing PostgreSQL database, `SESSION_SECRET`, and managed OpenAI through Replit AI Integrations; the read-only MCP itself needs none of these AI credentials. Managed workflows provide `PORT` and `BASE_PATH`.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- MCP: official TypeScript SDK, stateless Streamable HTTP
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/lib/elexon.ts` — bounded upstream requests, validated tool definitions, caching and result normalization.
- `artifacts/api-server/src/routes/elexon.ts` — MCP transport and portal API.
- `artifacts/api-server/src/lib/endpoint-tools.ts` — native endpoint schemas, safe serialization and bounded result pages.
- `artifacts/api-server/src/catalog/elexon-v1.json` — versioned, generated catalog pinned to Elexon's OpenAPI source hash.
- `artifacts/elexon-mcp` — connection portal.
- `lib/api-spec/openapi.yaml` — portal API contract.
- `README.md` — client connection and hosting guide.

## Architecture decisions

- Use the existing Node/TypeScript server rather than the Python illustration from the initial discussion to avoid a second runtime and share execution logic with the portal.
- Remain stateless so hosted requests can reach different autoscaling instances without losing an MCP session.
- Public, anonymous read-only tools are intentional: the source data is public and clients should connect without Elexon credentials. Publishing privately is an alternative; document external access tokens rather than implementing local login.
- Keep API date semantics explicit: UTC/offset timestamps for bounded windows; Europe/London for settlement dates. Never assume every settlement day has 48 periods.

## Product

All 326 GET operations in Elexon's pinned OpenAPI specification are exposed as individual native `elexon_get_*` tools, in addition to the four original convenience tools. Users can search/filter the catalog, inspect endpoint schemas, execute live requests and load the next page.

Ask Elexon at `/ask` uses the official MCP SDK against the same full server, discovers bounded subsets of tools, and creates validated data-driven narratives, charts, provenance diagrams, dashboards and real xlsx/docx/pdf downloads. AI calls use managed OpenAI and Replit credits, never a user-supplied key. Ask uses `gpt-6-luna` through the Responses API (medium reasoning); do not move it to Chat Completions, which only supports Luna function calling with reasoning disabled. Keep SDK initialization lazy so missing AI setup does not break MCP or existing portal features.

Exports must include only the currently selected analysis, with its charts and tables, never other saved analyses from the browser's history.

Use friendly names for recognised fuel categories and other relevant analysis labels, consistently in charts, tables and exports. Keep original codes available for reference and leave unknown codes unchanged rather than guessing their meaning.

The web app is an installable PWA (manifest, icons, `public/sw.js`). The service worker registers only in production builds, caches the app shell and hashed assets, and must never cache `/api` responses; bump its cache version if caching rules change.

Opening Ask must start a blank new question rather than automatically selecting a saved analysis. Saved analyses remain explicitly selectable. Keep the composer editable and paginate evidence tables so large historical results do not block typing or other actions.

The user expects an intelligent LLM-based analyst, not merely raw API retrieval: perform the aggregation or other required preprocessing on collected evidence before answering. Do not tell users to do a further grouped calculation when the retrieved data supports it. Energy comparisons must integrate documented interval-average power into MWh, with coverage checks; do not sum MW and relabel it as energy, or present GB electricity as whole-UK energy.

Private saved results are browser-scoped with HMAC session identifiers and seven-day access. All Ask requests share a persistent browser credential so embedded previews work without cookies; existing valid cookies are migrated without losing owned results. Never expose global histories or accept another browser's answer ID. The owner requested removal of app-imposed AI quotas: do not reintroduce daily/lifetime allowances, per-question token/tool/model-call budgets, or question concurrency caps. Retain cancellation, validation, session isolation and provider/upstream technical safeguards. Generated report files are rendered on demand; only the validated JSON analysis model is saved.

`pnpm --filter @workspace/api-server run ask:verify-data` checks live MCP data and all export formats without using AI. Its ignored verification outputs are not a substitute for live natural-language testing. See README's Ask Elexon section for limits, report preview bounds, safe calculations, timezone rules, retention and Unicode handling.

## User preferences

The user requested an Elexon MCP server hosted on Replit.
- Change only the original orange accents to green, not the entire theme. Keep the original navy, warm off-white backgrounds and teal unchanged. This is not an official Elexon product; retain independent branding and the affiliation disclaimer.
- The user requested the entire API scope, not only the initial four tools. Keep existing shortcuts compatible when expanding native endpoint coverage.

## Gotchas

- MCP endpoint is `/api/mcp`; it is not the API documentation URL and not a legacy SSE endpoint.
- Only report a production endpoint obtained from deployment metadata; development preview URLs are not stable public endpoints.
- Initial type generation needed `dom.iterable` in the API client's TypeScript library list and explicit React Query version 5 in Orval.
- Native tools preserve endpoint-specific filters and interval semantics. Only convenience tools use the blanket 24-hour limit. Native `_limit`/`_offset` controls page a bounded upstream response; oversized downloads require narrower upstream filters.
- Regenerate/verify coverage with the API server's `catalog:generate` and `catalog:verify` commands. Specification changes are deliberate pinned updates, not runtime tool-list changes.
- No browser end-to-end tests or architecture review were requested for the first build.

## Pointers

- API monitoring must run independently of the monitored web server, retain at least one year of history (implemented retention is 400 days), and show missing checks as unknown. The owner chose independent checks and continued without Better Stack. The separate one-shot checker and scheduling instructions are in `docs/api-monitoring.md`; publishing the web app does not by itself activate recurring checks.
- The owner selected email notifications via Resend. Delivery is opt-in and defaults to simulation; never send real test alerts without separate approval. Stale-checker alerts need a separate watchdog schedule. See `docs/api-monitoring.md` for configuration, confirmation thresholds, opt-out, and delivery limitations.

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
