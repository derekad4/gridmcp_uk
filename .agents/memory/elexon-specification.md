---
name: Elexon specification caveats
description: Non-obvious differences between Elexon's API schemas and its illustrative examples.
---

Elexon's OpenAPI examples are not always valid against their declared schemas. Some date-time parameters illustrate space-separated timestamps, while the schema requires ISO date-times; date-only examples can also appear under date-time schemas.

**Why:** Using upstream examples verbatim made otherwise-valid endpoint tools fail their own input validation.

**How to apply:** Preserve the declared parameter schemas, validate example values before publishing them, and generate timezone-qualified ISO timestamps where the illustrative example is invalid. Do not loosen calendar or timestamp validation solely to accommodate a documentation example.
