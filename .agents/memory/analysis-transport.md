---
name: Large analysis transport
description: Why saved-analysis navigation must not transport every historical raw dataset.
---

Keep saved-analysis history as a lightweight index; fetch a full answer only after explicit selection, with transport compression and unchanged ownership checks.

**Why:** Long fuel analyses produced saved answers tens of megabytes in size. The server logged successful history responses while the user saw a failed history load. Fetching every raw result merely to show titles makes browser and intermediary limits part of basic navigation.

**How to apply:** Project only summary fields in the database query, not after fetching full JSON. Preserve all saved observations and export data. Verify a large saved answer can be selected and restored in full, and that cookie-blocked and unrelated sessions still behave correctly. Do not infer that the user has no saved analyses when history loading fails.
