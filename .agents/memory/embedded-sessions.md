---
name: Embedded browser session verification
description: Why Ask session checks must cover requests without cookies, not just standalone browsers.
---

Verify the entire question → saved history → export flow with cookies withheld, as well as ordinary browser sessions.

**Why:** An ordinary fresh-browser run displayed and restored results, but the user's preview showed an export ownership error. A displayed streamed answer proves neither that a later request retains its identity nor that export authorization succeeds. The no-cookie browser flow is a distinct regression case.

**How to apply:** Preserve browser ownership checks, test all download formats and reloads with Cookie headers removed, and confirm an unrelated browser cannot access the same answer. Do not bypass ownership checks to recover a result whose credential has been lost.
