# Manual API health checks

The Health page now runs checks **only when a visitor presses Run check**. Opening the page, refreshing saved history or selecting a date range does not probe an API. No scheduled deployment or external monitoring integration is required.

Each run probes the fixed Elexon reference endpoint and configured production MCP metadata endpoint, then saves both observations with source `manual`. The check validates HTTP and response shape, has a 12-second timeout and is globally limited to one run per 30 seconds. Manual checks never invoke paid AI, advance independent-monitor alert state or send email.

The page displays saved manual checks, their success rate, and response-time charts for up to 400 days. These are point-in-time samples, not continuous uptime, downtime durations or scheduled-check coverage. Older periods are not reconstructed. History is shared across visitors. The latest result becomes unknown after ten minutes; an unreachable website cannot check itself.

`POST /api/monitoring/check?days=30` accepts same-origin JSON browser requests; `GET /api/monitoring?days=30` only reads manual history. The production MCP target still uses the existing owner-configured `MONITOR_APP_URL`. No hosting change is needed.

## Legacy independent-worker reference

The remaining reference documents the retained worker implementation. It is **not the operating mode of the Health page**, and no recurring schedule has been activated. References below to the earlier Health-page UI describe that legacy mode only.

The **Health** page (`/health`) reads persisted checks for the Elexon upstream API and this application's published API. It never starts a probe from a browser request. The existing `/api/healthz` badge only reports that the application is responding; it is not an independent uptime check.

## Activate independent checks

The checker is a separate, one-shot process. **Publishing the web app alone does not schedule it.** The page intentionally displays “waiting” until independent checks arrive and “stale” when they stop.

1. Publish the app, including the new `api_health_checks` schema, through the normal publishing flow. Do not overwrite production data.
2. Create a **separate scheduled deployment** or use an independent scheduler. Keep the existing web deployment as Autoscale; do not replace its command or turn the web app into a scheduled job.
3. Give the checker access to the **same production PostgreSQL database** and set its non-secret `MONITOR_APP_URL` to the published HTTPS origin, without `/api` or a development-preview hostname. A checker in a different environment must be explicitly connected to that same database; merely copying code does not share a database. Keep database credentials in Secrets, never in source or URLs.
4. Build: `pnpm --filter @workspace/api-server run build`
5. Run command: `node --enable-source-maps artifacts/api-server/dist/monitor-worker.mjs`
6. Schedule every five minutes: `*/5 * * * *`.
7. Verify successive, distinct five-minute check slots appear on Health. A recent single check is not proof a recurring schedule was activated. Confirm records are being written to the production database visible to the production page, not only development.

The worker writes directly to PostgreSQL. If the monitored web app is unreachable, a running worker can still record that failure. If the checker or database itself is unavailable, the gap is unknown, **not** a successful check or a fabricated app outage.

The owner declined Better Stack and selected **email** for notifications. Resend supplies optional email delivery; checks alone do not require an email provider. Scheduling/hosting still has to be activated outside the monitored web server. This project does not attempt to publish or purchase that hosting automatically.

## Meaning and retention

- **Up:** successful HTTP response with expected JSON.
- **Degraded:** successful, valid response taking more than two seconds.
- **Down:** HTTP failure, timeout, network/TLS failure, or an invalid response.
- **Unknown:** no independent observation or no observation in the past ten minutes.
- **Recorded availability:** successful checks, including slow responses, divided by recorded checks. Five-minute samples cannot prove uninterrupted availability between observations.
- **Coverage:** received check slots divided by expected five-minute slots across the selected period, including dates before monitoring started. Low coverage must remain visible beside availability.
- Response latency is time to receive/validate the HTTP response, including HTTP error responses where available. Timed-out/network-failed requests have no response-latency value.
- The representative Elexon fuel-reference endpoint and MCP server-metadata endpoint are checked. This is not exhaustive endpoint coverage, an MCP tool-execution test or an AI availability check.
- Outages show first/last failed observations and a subsequent observed recovery. A missing check splits the episode; unobserved time is not filled in. Start/recovery timestamps are observation boundaries, not exact physical failure times.
- Raw checks are retained for **400 days**, covering more than a leap year. Historical records begin when real independent checks run; earlier dates remain unknown.
- The chart range supports 1, 7, 30, 90, 365 and 400 days. Graphs aggregate by five-minute slot, hour or UTC day. Missing buckets stay null; they are not interpolated.
- Recent-check and outage tables show the latest 100 entries in the chosen interval. Full retained records remain in PostgreSQL.

## Development verification

`pnpm --filter @workspace/api-server run monitor:once -- --verify` runs real probes in a separate process but tags them as verification. Verification checks do **not** appear as scheduled uptime history, so a development test cannot falsely activate the dashboard. Omitting `--verify` records an independent run but does not create a recurring schedule.

## Opt-in email notifications

Email is **off by default**. The owner chose email before a Resend connection was attached. No real test alerts have been sent. The Health page shows configuration and watchdog status without exposing email addresses, credentials, or public configuration controls.

Apply the additive `api_monitor_alert_state` and `api_monitor_alert_events` schemas with the normal database migration flow before running the updated app or jobs. Do not replace the production database. These tables retain incident state and the delivery queue across process restarts; concurrency is serialized with a PostgreSQL advisory lock and queue creation/state changes commit together.

Configure **both** the independent checker and the watchdog:

| Setting | Meaning |
| --- | --- |
| `MONITOR_EMAIL_ENABLED` | Exact `true` opts in. Anything else disables notifications. |
| `MONITOR_EMAIL_DRY_RUN` | Defaults to `true`. Only exact `false` permits real delivery. |
| `MONITOR_EMAIL_FROM` | One plain sender email address, verified in Resend. |
| `MONITOR_EMAIL_TO` | One plain recipient email address. |

The workspace has the owner-provided sender/recipient configured, with email **disabled** and simulation enabled. Those workspace settings are not proof that separate scheduled deployments have them. Enable live delivery deliberately in the scheduled environments only when ready: `MONITOR_EMAIL_ENABLED=true`, `MONITOR_EMAIL_DRY_RUN=false`. The web server’s configuration is informative only and never schedules delivery.

Provider authentication uses the managed Resend connection via `@replit/connectors-sdk`. Do not put keys, connector tokens, or database credentials in source, email URLs, logs, browser settings, or the database queue. Keep credentials in the managed connection/Secrets. If the jobs run in another Replit project, attach the authorized Resend connection there too; an external host cannot use this project's connection automatically. This implementation does not copy credentials or install an external-host sender. Check that the chosen scheduled host supports the managed connection before activation.

### Confirmation and duplicate protection

- Each API outage requires **two failed observations in adjacent five-minute slots**, after opt-in. Recovery requires two successful adjacent observations after the alert. Slow but valid responses count as successful.
- The first invocation establishes a baseline. It does not replay old incidents. With five-minute checks, confirmation normally takes about five to ten minutes after a failure.
- Gaps or observations older than ten minutes cannot confirm API outages or recoveries. Missing time is unknown.
- Each confirmed transition creates one persistent event. Re-running a slot, restarting a worker, or overlapping checker/watchdog runs does not create another event for the same transition.
- Further outage emails for the same API/checker have a **30-minute cooldown** from the last confirmed outage. Recovery is not delayed beyond its two successful samples. A new outage still present after cooldown can then be confirmed.
- Delivery failures leave events queued and cause the job to exit unsuccessfully. The next scheduled run retries the same immutable payload and Resend idempotency key. Up to three events are sent per run, in order; a failed send blocks later events until retry or expiry.
- Resend deduplicates keys for 24 hours. Ambiguous sends expire after **23 hours** instead of retrying beyond that protection window. Expired deliveries remain visibly counted on Health; they require investigation, not an automatic new-key resend. Successful API acceptance is not proof that an email reached an inbox.
- No repeated reminder emails are sent for an unchanged outage. Completed/simulated/cancelled/expired events are retained for 400 days. Payloads include sender/recipient addresses, so keep monitoring database access private.
- Simulation uses a separate state namespace and records `simulated` events without invoking the provider. Switching modes resets the other namespace and cancels its pending emails, avoiding delayed live sends from a simulation.

### Detect a stopped checker

A checker cannot notify anyone once it has stopped. Configure a **separate watchdog schedule**, preferably on a failure-independent scheduler, every five minutes:

```sh
node --enable-source-maps artifacts/api-server/dist/monitor-worker.mjs --watchdog
```

It only reads persisted independent observations; it does not probe the APIs or depend on the monitored web server. If either target has no observation within ten minutes, it sends one stale-checker email (after a ten-minute initial grace period). A complete set of two adjacent recent check slots confirms checker recovery, independently of whether those APIs are up or down. Verification checks never count.

The Health page reports the watchdog’s last completed evaluation. “Never” or an old timestamp is **not** active stale-checker protection, even if email settings say live. Confirm multiple watchdog runs and checker runs in the shared production database. Do not run the watchdog from the checker itself, a web-server timer, or a Health-page request.

This watchdog shares the monitoring database and email provider. If that database, the watchdog’s host, or the provider is also unavailable, it cannot guarantee a notification. Enable the scheduler/host’s own job-failure alerts for that case. No self-hosted monitor can independently detect its own entire infrastructure failing.

### Opt out and test safely

To opt out, set `MONITOR_EMAIL_ENABLED=false` in **both** scheduled jobs. Let at least one disabled invocation finish: it cancels pending messages and clears the alert baseline. Re-enabling then confirms new incidents rather than replaying old ones. A provider request already in flight cannot be recalled.

Run automated tests without any email delivery:

```sh
pnpm --filter @workspace/api-server run monitor:alerts:test
```

The tests use pure policy evaluation, a fake provider, and temporary database tables isolated from monitoring history and real alert state. They cover outage/recovery confirmation, both APIs, missing checks, stale checker/recovery, flapping, duplicate suppression, retry after an uncertain send, expiry, opt-out, simulations and transport failures. They never call Resend or real probe endpoints. `monitor:once -- --verify` also bypasses alert evaluation entirely; `--verify --watchdog` is rejected.

For an operational dry run, keep `MONITOR_EMAIL_DRY_RUN=true` and opt in in the scheduled environments. Inspect simulated events in the monitoring database and the watchdog timestamp; this records real checks and simulated state, **not real emails**. Do not force production API failures or send a test email without separate owner approval.
