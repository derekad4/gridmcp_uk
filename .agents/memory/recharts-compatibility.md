---
name: Recharts compatibility checks
description: Silent rendering omissions in the installed Recharts 2 renderer.
---

When changing chart composition, verify axes, unit labels, legends and hover details separately from the plotted marks. Keep chart primitives as direct children (a keyed array works), not wrapped in a React Fragment.

**Why:** Recharts 2 can draw lines, areas and bars while silently ignoring axes, legends and tooltips hidden in a Fragment. A render without a runtime error or an obvious blank chart is not sufficient evidence.

**How to apply:** Preserve direct child discovery when sharing chart elements. For narrow-range measures such as frequency, also inspect useful numeric precision and full timestamp precision rather than only the existence of tick labels.
