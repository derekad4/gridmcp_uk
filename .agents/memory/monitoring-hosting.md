---
name: Health check operating mode
description: The owner's choice of manual health checks and caveats for any future independent scheduling.
---

The owner switched the Health page to manual, button-triggered checks after independent scheduling could not be activated. Do not resume scheduling setup or show the page as continuous monitoring without a new request.

**Why:** The checker and dashboard were built, but no recurring production schedule was activated. The owner explicitly requested manual checks and corresponding page context instead.

**How to apply:** On the Health page, only explicit button presses should initiate probes. Keep manual snapshots separate from scheduled and verification evidence. Describe successful-check percentages, not continuous uptime or measured outage duration. Keep the website on Autoscale; retained independent-worker code is legacy, not an active schedule.

Verify platform scheduling support against actual documentation and available configuration controls, not just the generated documentation-search answer.

**Why:** Documentation search repeatedly claimed a Scheduled artifact could be added alongside Autoscale. The fetched artifact guides instead describe one shared publishing lifecycle, and the available artifact instructions expose no Scheduled artifact type or cron schema.

**How to apply:** Do not invent scheduling fields in artifact metadata or switch the whole website to Scheduled. If no supported independent scheduling control is available, clearly distinguish preparing the checker here from publishing it on a separately scheduled host. Obtain agreement before substituting always-on shared hosting, which changes costs and failure independence.
