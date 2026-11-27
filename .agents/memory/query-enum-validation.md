---
name: Numeric query enums
description: Generated numeric enum validation differs from incoming HTTP query values.
---

Do not assume generated numeric query-enum schemas coerce HTTP strings.

**Why:** The generated client and server both typechecked, but a valid year-range request was rejected because numeric literal unions require numbers while Express receives query strings.

**How to apply:** Normalize only explicitly permitted numeric enum strings before applying the generated schema. Keep unsupported strings, arrays and extra formats invalid. Exercise a real HTTP request with the serialized query value, not only a schema parsed with an in-memory number.
