# UK Grid MCP

Independent, public, read-only Model Context Protocol server for Great Britain's electricity market data. No Elexon API key is required.

## Connection

Publish the Replit project, then append `/api/mcp` to the published URL. Use a client that supports **Streamable HTTP**. The preview URL is not a stable production endpoint and may require collaborator access.

Example remote-client configuration (replace the URL with the published endpoint):

```json
{
  "mcpServers": {
    "elexon": {
      "url": "https://YOUR-PUBLISHED-HOST/api/mcp"
    }
  }
}
```

Clients differ in their configuration format. In a client with an Add remote server dialog, enter the endpoint URL directly and choose Streamable HTTP / no authentication. This is not a stdio or legacy SSE server.

## Full API coverage

The server exposes **330 tools**: one native tool for each of the **326 GET operations** in the pinned Elexon OpenAPI definition, plus the four original convenience tools.

Native tools start with `elexon_get_`. The tool catalog includes endpoint paths, descriptions, categories, deprecation flags, required parameters, enums, array types, dates and complete input schemas. The portal supports text search, category/type filters, live execution and next-page navigation.

Coverage includes BMRS datasets and streams, balancing mechanism dynamic/physical data, bid-offer acceptances, REMIT, generation, demand, forecasts, settlement, SAA reports, reference data, system data and documented legacy endpoints. A listed legacy endpoint may have been retired or redirected by Elexon; the tool reports the upstream error rather than inventing a replacement or silently returning another dataset.

### Native endpoint arguments

Use Elexon's original parameter names, such as `settlementDate`, `publishDateTimeFrom`, `bmUnit` or `partyIds`. Arrays must be JSON arrays, booleans must be JSON booleans and integers JSON numbers. Dates are validated calendar dates; date-times require ISO 8601 with a timezone. Required identifier examples may need replacement with a real BM unit/message/participant ID.

Native tools add local pagination controls **`_limit`** (1–500, default 100) and **`_offset`** (non-negative, default 0), without overwriting any upstream parameters. Follow **`nextOffset`** while keeping upstream filters unchanged. This paginates the returned upstream payload, not the complete historical archive. Data can change after cache expiry, so pagination is not a transactionally frozen snapshot. Preserve any upstream continuation metadata and use the API's filters where applicable.

Native tools preserve endpoint-specific interval semantics, units, nested records and metadata. Scalars are wrapped as `{ "value": ... }`. XML, CSV and plain-text responses become `{ "text": ..., "contentType": ... }` records; JSON is selected by default where the API supports a format argument.

Downloads are capped at **4 MB** and returned native pages at approximately **120 KB** of data/metadata (also at most 500 rows). If a response or individual record is too large, narrow the upstream date/identifier filters; reducing `_limit` alone cannot shrink the upstream download. Unknown arguments, unsafe path values, invalid inputs and upstream failures produce explicit errors.

### Original convenience tools

- `get_system_prices`: `settlement_date` (YYYY-MM-DD), optional `settlement_period` (1–50).
- `get_generation_by_fuel`: `from` and `to` (ISO timestamps with UTC offsets), actual generation by fuel in MW.
- `get_demand_outturn`: same time inputs, initial national and transmission demand in MW.
- `get_wind_forecast`: same time inputs, latest available wind generation forecasts in MW (not an as-of forecast archive).

The four convenience tools retain `limit` (1–500; default 100) and `offset` (0–10000; default 0). Their time ranges are [from,to) and limited to 24 hours. Use `totalCount`, `truncated` and `note` to paginate. These convenience rules do not replace native endpoint semantics. An empty result means no available data, not zero.

### Refreshing existing MCP clients

Reconnect or refresh tool discovery to see the full catalog after upgrading. Some clients limit the number of enabled tools; use their selection controls to enable the categories/tools you need. All operations are advertised individually over the same `/api/mcp` endpoint, rather than hidden behind an unrestricted HTTP-request tool.

Dates use real calendar validation. Settlement dates are Europe/London; DST dates can have 46 or 50 periods instead of 48. Price values are GBP/MWh, balancing volumes are MWh and generation/demand are MW. Data is subject to revision. Keep the returned source URL and retrieval time with your analysis.

### Public historical observation cache

Repeated historical questions reuse normalized public-source responses across browsers, without caching questions, calculated analyses, answer IDs, session credentials or exports. Eligible routes are FUELHH/FUELINST, AGPT/INDO/ITSDO datasets with bounded settlement dates, demand outturn, actual generation per type, and dated settlement system prices. All upstream filters (including fuel, settlement period and revision selectors) remain part of the cache key; local page size/offset do not. Measurement filtering, pagination and calculations still run separately for each analysis.

Only windows ending more than seven days ago qualify (settlement dates use an additional conservative two-day end buffer). These responses expire **six hours after the original download**, not six hours after a cache hit, so later revisions are fetched again. Recent/future data, unbounded requests, other routes and latest forecasts retain the existing **30-second** cache. Empty responses and responses declaring incomplete upstream pagination are not retained in the historical cache; missing windows remain missing, not zero. There is no stale-on-error fallback. `fetchedAt` always identifies the original download; combined Ask evidence records it for each date window. A refresh between pages produces explicitly incomplete evidence rather than mixing revisions.

The historical cache is a separate in-memory LRU per server process, capped at **64 MB and 4,096 source responses**, in addition to the existing short-lived cache. It is opportunistic: restarts, capacity eviction and different autoscaling instances can cause downloads again. Nothing is written to browser-owned analysis storage, and no new persistent data store is required.

## Hosting and access

The server is intentionally anonymous: it exposes only fixed read-only tools against public Elexon data. Anyone who can reach a public deployment may query it. No private account data or write operations are exposed.

60 execution calls per minute per IP across the executor and MCP routes, 8 concurrent upstream requests per process, bounded inputs, response-size limits, a 30-second in-memory cache (50 entries / 24 MB of upstream payloads), the separate historical observation cache described above, identical-request deduplication, and upstream 429 cooldown are included. Cache/rate limits are best-effort and per instance, not a distributed quota. Stateless MCP requests work across autoscaling instances.

For restricted use, publish privately and use a Replit Production external access token in a compatible client's request headers. A deployment's password gate is generally unsuitable for automated MCP clients.

The web portal shows the endpoint, setup instructions and a live tool explorer. Its online badge describes this server, not Elexon's upstream service availability. Requests fail explicitly when Elexon is unavailable.

## Development

- `pnpm --filter @workspace/api-server run dev`
- `pnpm --filter @workspace/elexon-mcp run dev`
- `pnpm run typecheck`
- `pnpm --filter @workspace/api-server test` — catalog, artifact, grounding, real-format export, request-isolation and quota checks (Ask tests use the development PostgreSQL database and roll back budget changes).
- `pnpm --filter @workspace/api-server run ask:verify-data` — explicitly query live Elexon data through the official MCP SDK, then verify line/area/bar/composition views and generate actual Excel, Word and PDF reports under ignored `generated-artifacts/`. This does not call AI and must not be represented as natural-language journey verification.
- `pnpm --filter @workspace/api-server run catalog:verify` — compare the pinned catalog with the live Elexon specification.
- `pnpm --filter @workspace/api-server run catalog:generate` — intentionally refresh the pinned endpoint catalog after reviewing specification changes.
- After changing `lib/api-spec/openapi.yaml`, run `pnpm --filter @workspace/api-spec run codegen`.

Replit runs both services through the configured workflows. The API is under `/api`; MCP is `/api/mcp`.

The versioned catalog is `artifacts/api-server/src/catalog/elexon-v1.json`. It contains the upstream API version and SHA-256 of the source specification. There is no runtime dependency on Elexon's documentation server: the pinned catalog is bundled with the API server. New upstream endpoints require regeneration and verification, not silent runtime changes.

### Live native endpoint smoke check

Specification equality does **not** prove the advertised endpoints still return usable data. Run this separately and explicitly:

```sh
pnpm --filter @workspace/api-server run endpoints:smoke \
  --report ../../generated-artifacts/elexon-smoke/report.json
```

Or use **Actions → Elexon live endpoint smoke → Run workflow** in a GitHub repository with Actions enabled. This manual-only workflow is independent of specification drift, offline CI, builds and startup. It installs the locked workspace dependencies but needs no running server, database, credentials or AI. The command imports only the native endpoint executor and its loader; it never invokes Ask Elexon or an AI model.

Each fresh process runs these five fixed native tools once, sequentially, with `_limit=5`, `_offset=0` and no next-page requests:

| Pinned GET path | Upstream filter | Sampled usability contract |
| --- | --- | --- |
| `/balancing/settlement/system-prices/{settlementDate}/{settlementPeriod}` | Date three UTC days ago, period 1 | Settlement date/period and numeric buy/sell prices |
| `/generation/actual/per-type` | 00:00–00:30 UTC three days ago (native interval semantics) | Start timestamp and nonempty nested production types/quantities |
| `/demand/outturn` | Same settlement date for both bounds, period `[1]` | Start timestamp and numeric national/transmission outturn |
| `/datasets/FUELHH` | Same settlement date for both bounds, period `[1]`, fuel `["NUCLEAR"]` | Fuel type and numeric generation |
| `/datasets/FUELHH/stream` | Same FUELHH filters | Same contract, exercising the stream response |

The recent completed-day window avoids typical same-day publication lag and historical archive downloads. Settlement filters are date labels interpreted by Elexon in Europe/London; period 1 exists on both DST transition days. No hardcoded historical examples, identifier discovery, fallback date search or endpoint substitutions are used. JSON is selected where supported. These samples cover path parameters, date and timestamp queries, arrays, nested records, dataset envelopes and streams—not all 326 endpoints, all categories, complete response schemas, freshness, or economic correctness. Only up to five returned rows per endpoint are checked; additive fields are allowed. A valid empty array or `data: []` is **`empty_valid`**, not a zero measurement and not proof that populated rows conform.

The JSON report includes the clock, pinned specification hash, exact tool names, filters, source URLs, counts, cache status and per-sample outcomes:

- **`ok` / `empty_valid`**: usable sampled rows / a successful empty native result.
- **`retired_or_missing`**: HTTP 404/410 (a signal to investigate, not proof of permanent retirement).
- **`redirected`**: HTTP 3xx; the destination is never followed.
- **`upstream_unavailable`**: network/timeout errors or HTTP 5xx.
- **`rate_limited`**: HTTP 429 or the native loader's cooldown; later samples may be blocked without a request.
- **`schema_failure`**: malformed JSON or rows that fail the small usability contracts, including HTML/error envelopes returned with HTTP 200.
- **`size_limit`**: native download, metadata or individual-record bounds were exceeded.
- **`upstream_rejected` / `check_error`**: another upstream HTTP rejection / invalid native inputs, a missing pinned sample, or a check implementation error.

Exit **0** means every sample is `ok` or `empty_valid`; **1** means at least one sample failed; **2** means the command/report could not finish. Failure never removes tools, changes the catalog or substitutes another dataset. Review the exact failed URL and classification before deciding whether to retry or deliberately update the catalog. GitHub retains the report for 30 days and includes it in the run summary. Local report paths are relative to `artifacts/api-server`; generated reports are ignored by Git and deployment.

All native safeguards remain active: 4 MB per upstream body, approximately 120 KB per returned page, 15 seconds per fetch attempt including body reads, manual redirects, 30-second cache and 429 cooldown. At most **10 HTTP attempts** are possible (five samples, at most one existing native retry on 5xx); no smoke-specific retries are added. Nominal worst-case fetch/wait time is under three minutes; the manual workflow has a five-minute overall timeout. Run it on demand rather than polling. A new CLI process starts with an empty native cache.

`pnpm --filter @workspace/api-server run endpoints:smoke:test` tests the smoke runner offline using mocked fetch responses. It never contacts Elexon and is deliberately separate from the live command and existing offline test commands.

### Elexon specification drift checks

`.github/workflows/elexon-coverage.yml` runs daily at **07:23 UTC**, on relevant pull requests and pushes to `main`/`master`, and manually through **Actions → Elexon specification coverage → Run workflow**. It requires a GitHub repository with Actions enabled; it does not schedule itself inside Replit. Scheduled runs use the default branch and GitHub may delay or disable schedules on inactive repositories. Keep Actions failure notifications enabled for the people maintaining coverage. The check uses Node 24 built-ins only, with no package installation, database, secrets or AI calls.

Each run first tests the comparison offline, then downloads the official live specification. A nonzero result fails the run:

- **0:** identical pinned/generated catalogs and source SHA-256.
- **1:** drift detected, including source-hash-only changes.
- **2:** coverage could not be checked, for example download/HTTP failures, malformed JSON or unsupported parameter schemas. This must not be treated as a clean result.

The run summary lists both source hashes, pinned/fetched GET counts, added/removed operation paths, operation metadata changes and individual parameter additions/removals/changes with before/after values (including required flags, types, formats, enums, examples and serialization). Ordering and source-only changes are also flagged. Changes outside generated tool definitions still change the raw source hash and require review, even when no GET operation changed.

The `elexon-specification-comparison` run artifact retains `report.md` and the exact fetched `swagger.json` for 30 days. A failed download may leave only a report; unsupported schemas retain the source for investigation. The workflow has read-only repository permissions and **never regenerates or commits the pinned catalog**.

#### Review and accept an upstream change

1. Read the failed run's summary and download its comparison artifact. Inspect removed/deprecated operations, new required parameters, schema/enum changes and the source-hash change. If only the hash changed, inspect the specification itself rather than assuming the change is harmless.
2. Save the downloaded `swagger.json` to `generated-artifacts/elexon-coverage/swagger.json` (ignored by Git and deployments). Alternatively, capture a fresh local comparison:

   ```sh
   pnpm --filter @workspace/api-server run catalog:verify \
     --report ../../generated-artifacts/elexon-coverage/report.md \
     --snapshot ../../generated-artifacts/elexon-coverage/swagger.json
   ```

   Paths passed through these package commands are relative to `artifacts/api-server`. Exit 1 is expected when drift exists; exit 2 requires fixing the check or retrying the download, not accepting an unchecked update.
3. On a review branch, deliberately generate from those **same bytes**, avoiding a second download changing the review target:

   ```sh
   pnpm --filter @workspace/api-server run catalog:generate \
     --spec ../../generated-artifacts/elexon-coverage/swagger.json
   git diff -- artifacts/api-server/src/catalog/elexon-v1.json
   pnpm --filter @workspace/api-server run catalog:verify \
     --spec ../../generated-artifacts/elexon-coverage/swagger.json
   pnpm --filter @workspace/api-server run catalog:test
   pnpm --filter @workspace/api-server exec tsx --test src/lib/endpoint-tools.test.ts
   pnpm run typecheck
   ```

4. Review tool names, input validation and client compatibility. Unsupported upstream schemas require a deliberate generator/runtime change and tests before acceptance; do not remove validation to force a pass. Update coverage counts in documentation when necessary. Commit the reviewed catalog (and any needed code changes) through a pull request, not the downloaded snapshot or report.
5. Run `pnpm --filter @workspace/api-server run catalog:verify` again against live upstream before merging. If upstream moved again, review a new snapshot; the offline check proves only the accepted snapshot matches. Refresh existing MCP clients' tool discovery after the reviewed update reaches the app.

`catalog:generate` with no arguments still deliberately fetches and regenerates live; prefer `--spec` for reproducible reviews. `catalog:verify --spec FILE` supports offline reproduction, and `catalog:test` never contacts Elexon. Application startup and builds continue to use only the committed catalog.

## Ask Elexon

The `/ask` page adds private browser-scoped questions, follow-ups, progress, cancellation, saved evidence, declarative visuals and downloadable reports. It uses **OpenAI through Replit AI Integrations**, with no user-supplied API key. **AI usage is billed to the app owner's Replit credits.** Enable the managed OpenAI integration before using paid questions; if it is missing, the page explains this and disables asking. Existing MCP tools, saved results and exports remain usable. The managed SDK client is retained in `lib/integrations-openai-ai-server` and loaded only when AI runs.

Ask requires the existing Replit PostgreSQL database and `SESSION_SECRET`. Push the development schema with `pnpm --filter @workspace/db run push`. The normal post-merge setup already installs packages and pushes the development schema; production schema changes belong to Replit's normal publish flow, never server-startup migrations.

### Evidence and visuals

The assistant uses the official MCP client and linked in-memory transports to discover and invoke the **same full MCP server** used by external clients. This avoids a self-HTTP request and does not bypass MCP tool input validation or replace the catalog with hard-coded endpoints. Discovery searches all 330 tools and enables up to six matching tools at a time; at most eight pending schemas are sent to OpenAI. Discovery messages do not duplicate those schemas. Successful tools leave the callable set until rediscovered, preserving room for returned evidence within the fixed context budget. Follow-ups resolve previous source identities against the current catalog and enable those exact tools directly, retaining unchanged filters rather than silently substituting a related dataset.

The model chooses queries and declarative view specifications, not executable code or chart values. The server validates every specification, normalizes returned rows, calculates numeric values deterministically and rejects missing columns, ambiguous units, implicit duplicate aggregation and unsuitable signed composition. Numeric claims in generated prose/titles are omitted rather than trusted as calculations; observed values and explicitly scoped arithmetic means remain visible. Queries with unknown units stay available as tables but cannot create unitless measured charts. FREQ units are Hz as documented in the pinned Elexon FREQ dataset description.

Charts support line, area, bar and category composition. A dashboard combines multiple validated views and page statistics; it does not refresh automatically. Diagrams currently show verified **source → query provenance**, labeled as relationships rather than measured flows. These API records do not establish physical network topology or causality, which is explained when requested.

Date context uses deterministic Europe/London today/yesterday/week boundaries, including 23/25-hour DST days, while preserving UTC/offset instants and settlement calendar dates explicitly. Query filters, observed coverage, units, source URLs, retrieval times, upstream metadata, pagination offsets, missing values and bounded-data notices accompany results.

### Privacy, cost and failure limits

- A cryptographically random browser credential persisted in local storage identifies Ask requests via `X-Ask-Session`, including history, questions, follow-ups and exports. This also works when embedded previews block cookies. Only its HMAC is stored in PostgreSQL. A valid legacy httpOnly cookie migrates its owned results to the persistent browser session. There are no public conversation URLs or account histories. Anyone sharing the same browser profile can see that profile's results.
- The most recent 20 completed results are restored for seven days. Expired rows are inaccessible immediately and removed on subsequent analysis reservations. Follow-ups and exports require the owning browser credential. Clearing site storage loses access; if persistent storage is unavailable, the credential lasts only for the current page session. Results whose previous credential was already lost cannot be recovered by knowing their answer ID.
- Questions: 3–32,000 characters, same-origin JSON POST required. No application question-rate, daily/lifetime usage or question-concurrency quotas; historical usage counters do not block requests. All paid use still bills to the owner's Replit credits.
- Execution: ten-minute technical timeout with cancellation; no model/tool-call quota, four-source ceiling or per-question token budget. The model's output ceiling is 8,192 tokens per call and its provider context limits still apply. Evidence is compacted automatically as context grows, without deleting saved data used for charts or exports.
- PostgreSQL records run ownership and saved answers, not paid-usage quotas. Run leases allow ten minutes plus cleanup time before expiration. The database failing means questions fail closed rather than losing saved results or session isolation.
- Ask automatically retrieves all local MCP pages for each filtered query, merges them before calculating metrics or charts, and preserves all returned rows and columns. Oversized cell text (12,000 characters) and metadata (8,000 characters) remain explicitly clipped. Upstream size/rate limits and nonadvancing or changing pages produce an explicit incomplete-data notice. A fully paged filtered response is not a guarantee of archive-wide completeness. Missing data is not zero.
- Disconnecting or cancelling aborts the current model request and stops subsequent tool/model calls; already running bounded upstream work and already incurred AI charges cannot be undone. Upstream and model error bodies are not exposed as internal errors or credentials.
- Export requests are separately throttled and have bounded process concurrency. No file paths or remote URLs are accepted from export inputs. Current limits are in `artifacts/api-server/src/lib/ask/store.ts`; do not raise them without reviewing credit usage.

### Real report formats

Exports are rebuilt on demand from the saved, validated analysis, without a second paid AI request or a new Elexon query. No generated report bytes are stored in the database.

- **Excel (.xlsx):** all saved bounded underlying/derived rows, column units, original filters, timestamps, source metadata, narrative, limitations and visual snapshots. Formula-like strings are explicit text and escaped for safe downstream copying.
- **Word (.docx) and PDF (.pdf):** narrative, metrics, sources/filters/limits, visual snapshots and readable table previews (first 50 of each saved dataset's rows). Wide tables use numbered column bands; notices identify previews and direct users to Excel for all saved rows. Reports paginate rather than clipping tables.
- PDF embeds a packaged Noto Sans font. Unicode outside its glyph coverage is shown as `[U+XXXX]` escapes rather than silently lost; Excel/Word retain original characters. Snapshot text uses available server fonts.

PDF and Word are genuine binary files, not renamed HTML/text or a print dialog. Source data remains bounded even when an export succeeds; no report claims exhaustive archive coverage.

## Attribution

Source: [Elexon Insights](https://bmrs.elexon.co.uk/api-documentation).
API definition: https://data.elexon.co.uk/swagger/v1/swagger.json .
Observe the BMRS Data Licence and API Terms linked from https://developer.data.elexon.co.uk/ .
This project is not affiliated with or endorsed by Elexon.
