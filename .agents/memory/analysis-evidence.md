---
name: Analysis evidence completeness
description: Why deterministic retrieval must enforce paging and measurement-time semantics.
---

Do not rely on prompt instructions alone to guarantee complete evidence or correct time coverage.

**Why:** Live fuel-mix questions continued to select publication-time filters and stopped at partial pages despite instructions to retrieve the measurement interval. Even a valid generated visual could reference a display alias instead of its verified dataset identifier, causing it to disappear during validation.

**How to apply:** Verify actual source filters, returned observation times, page completeness and rendered artifact references when investigating narrative-only answers. Preserve source identity; never repair an ambiguous reference by choosing arbitrarily between multiple datasets. Signed interconnector flows are real observations and must not be discarded to make a composition work.

Split long historical fuel intervals into valid per-request windows in backend retrieval, and resolve unambiguous requested months before the model can substitute a current-day sample.

**Why:** Prompt instructions to split ranges still produced answers refusing a month chart because of per-request limits, despite the historical source supporting the interval through multiple calls.

**How to apply:** Keep requested-range resolution, per-window pagination, source-window provenance and explicit missing-window reporting deterministic. A complete set of API responses is not proof that every expected measurement was published.

Apply visual fallback after validating model views, not only when the model supplies no views.

**Why:** A nonempty view list can still yield no charts when references, fields or series counts fail validation. Fuel data commonly has more categories than the supported multi-series chart limit.

**How to apply:** Recover only from an unambiguous verified source, preserve signed values and correct units, and disclose the supported aggregation rather than silently discarding a requested graph.

Give the analyst a way to calculate over complete retained evidence before it writes its answer, rather than relying on samples or generic summary statistics.

**Why:** The model refused to identify the largest fuel producer even after retrieving the whole interval, because it lacked a grouped calculation result. Prompting it to be smarter does not supply the missing analytical evidence.

**How to apply:** Expose validated, declarative transformations as model tools and feed their computed results back into the analysis loop. Keep calculations reproducible and separate from model prose; energy rankings need interval-duration integration, source coverage checks and a distinction between domestic generation and interconnector flows.

Share historical evidence only at the public-source boundary, before browser-owned datasets and calculations are created. Old Elexon observations must never be treated as permanently immutable.

**Why:** Repeated long-range questions should reuse public downloads across browsers without sharing private questions, analysis identities or credentials. Settlement revisions can arrive long after the measurement date, so historical age alone is not a reason to keep results indefinitely.

**How to apply:** Retain finite freshness from the original download time, not the last cache hit; preserve every source filter and per-window retrieval provenance. Recalculate analyses independently and report failed or empty windows explicitly rather than substituting stale success or zero.

Treat explicit visualisation requests as answer requirements, not optional presentation hints.

**Why:** The analyst returned valid energy totals and bar charts while omitting explicitly requested percentages and a pie chart. A nonempty chart list did not establish that the user's actual request was satisfied.

**How to apply:** Check requested types and percentage measures after validating model output. Derive shares from a meaningful, disclosed nonnegative denominator; domestic-generation shares exclude interconnectors while retaining their signed evidence separately. Honour the chosen type on first render, retain visible percentage labels, and cover saved-answer reads and exports as well as newly generated answers.
