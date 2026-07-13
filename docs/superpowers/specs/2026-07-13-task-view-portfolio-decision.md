# Task View Portfolio Decision

## Decision

Deft exposes four primary task views in the task header:

- **Board** for status flow and drag-and-drop planning.
- **Table** for dense editing, sorting, grouping, and saved operational views.
- **Timeline** for date sequencing and dependency context.
- **Calendar** for due-date planning.

**Pipeline** remains available under **Views** as a secondary business-stage lens. Direct `?view=pipeline` links and saved Pipeline views remain valid.

## Why

Pipeline currently reuses task status columns and optionally displays imported business metadata. That is useful, but it is not distinct enough from Board to occupy permanent primary navigation for every team. Moving it under Views keeps the capability without presenting two similar top-level flows.

The former List renderer is now the canonical Table renderer. Legacy `?view=list` links continue to normalize to `?view=table`; no second List implementation remains.

## Revisit

Promote Pipeline again only when Deft has durable typed business fields and pipeline-specific interaction beyond status columns, such as stage probability, value, or forecast behavior.
