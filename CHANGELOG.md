# Changelog

## 0.1.0 — 2026-08-25

Initial release.

- `/goal <objective>` starts AUTOPILOT: every `agent_settled` injects the next iteration until `/goal stop`.
- `/goal pause | resume | stop | status | note <text>`.
- Lifecycle is exactly RUNNING / PAUSED / STOPPED and only the user moves between states.
- Esc (interrupt) pauses; errors back off (10s → 5 min) and never stop the loop; liveness re-sends when a turn cannot start.
- Progress evaluator: files edited, commands run, test status and the model's summary are tracked per iteration; iterations without file changes rotate through twelve concrete lenses.
- `autopilot_progress` tool records milestones, blockers and notes (it cannot stop autopilot).
- Objective + rules appended to the system prompt on autopilot turns; mutable state block in every continuation.
- Compaction at ≥ 75 % context with autopilot-aware instructions before the next iteration.
- State persists as session entries and mirrors to `.pi/autopilot/{state.json,AUTOPILOT.md}`; startup/resume/fork restore a running goal as PAUSED, `/reload` keeps it running.
