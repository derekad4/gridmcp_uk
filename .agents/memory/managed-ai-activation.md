---
name: Managed AI activation in task chats
description: Distinguish unavailable task-chat provisioning from the app's actual managed AI connection.
---

An unavailable managed-AI activation callback in a task chat does not mean OpenAI is unsupported or that the app needs a personal API key. Activation through the main project's Agent can still supply the managed connection.

**Why:** The task chat could neither invoke the activation callback nor find OpenAI in the connector search, but the owner subsequently enabled the managed connection and the existing SDK integration worked after restarting the API.

**How to apply:** When provisioning itself is unavailable, report that specific limitation instead of changing providers or credentials. After the owner confirms activation, restart the API and verify an actual bounded question; a stale running process can still report the connection as unavailable.
