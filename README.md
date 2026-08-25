# pi-unstoppable

[![npm](https://img.shields.io/npm/v/pi-unstoppable)](https://www.npmjs.com/package/pi-unstoppable) [![CI](https://github.com/YellowFoxH4XOR/pi-unstoppable/actions/workflows/ci.yml/badge.svg)](https://github.com/YellowFoxH4XOR/pi-unstoppable/actions/workflows/ci.yml) [![Security](https://github.com/YellowFoxH4XOR/pi-unstoppable/actions/workflows/security.yml/badge.svg)](https://github.com/YellowFoxH4XOR/pi-unstoppable/actions/workflows/security.yml)

**AUTOPILOT for [Pi](https://github.com/earendil-works/pi).** Give Pi a goal; it keeps working toward it — inspecting, building, testing, hardening — until *you* say stop.

```
/goal Build a production-ready distributed job scheduler
```

```
● AUTOPILOT RUNNING  #17  2h 40m
  Goal  Build a production-ready distributed job scheduler
  Now   Implement lease expiry recovery
  Last  #16 · 3 file(s): lease.ts, lease.test.ts · 2 cmd(s) · tests passing · Added lease renewal + tests
  Esc interrupts (pauses) · /goal pause | resume | stop | status | note <text>
```

No iteration cap. No deadline. No context cap. No tool the model can call to declare itself done. The model decides **what** to do next; the harness decides **that** it continues.

## Install

```bash
pi install npm:pi-unstoppable
```

Try it without installing:

```bash
pi -e npm:pi-unstoppable
```

From GitHub (pinned to a tag; `pi update` does not move git refs):

```bash
pi install git:github.com/YellowFoxH4XOR/pi-unstoppable@v0.1.0
```

Or from a local checkout:

```bash
git clone https://github.com/YellowFoxH4XOR/pi-unstoppable
pi install /path/to/pi-unstoppable
```

Restart Pi (or `/reload`) after installing. Requires Pi ≥ 0.84 (for the `agent_settled` event) and Node ≥ 22 (same as Pi).

## Commands

| Command | What it does |
|---|---|
| `/goal <objective>` | Start autopilot. Asks before replacing an active goal. |
| `/goal pause` | Let the current run finish, then inject nothing more. |
| `/goal resume` | Continue from paused **or** stopped, with all progress state intact. |
| `/goal stop` | Terminate: abort the in-flight run, inject nothing more. |
| `/goal status` | Inspect objective, milestones, blockers, files, tests, errors. |
| `/goal note <text>` | Add durable guidance for future iterations without triggering a turn. |
| **Esc** | Pi's interrupt. Aborts the run and **pauses** autopilot so you regain control. |

Anything you type while autopilot is running is delivered as a normal message *and* captured as guidance that every later iteration sees.

## How it works

```
/goal <objective>
      │
      ▼
 ┌──────────┐   agent_settled    ┌─────────────────────┐
 │    Pi    │ ─────────────────► │  PROGRESS EVALUATOR │
 │ reason → │                    │  files? cmds? tests? │
 │ act →    │ ◄───────────────── │  stalled? errors?    │
 │ verify   │  next iteration    └─────────────────────┘
 └──────────┘  (user message)              │
                                     user said stop?
                                       no ──┘  yes → STOPPED
```

- **The engine** listens for Pi's `agent_settled` event — Pi has *nothing* left to do: no retry, no compaction retry, no queued follow-up. It then injects the next iteration with `pi.sendUserMessage()`, which runs through Pi's normal prompt pipeline.
- **Every iteration is measured** without asking the model: files edited (`edit`/`write`), commands run, test pass/fail (from the exit status of anything that looks like a test command), plus the model's own closing summary. That becomes the "Recent iterations" ledger the next prompt sees.
- **Stall detection.** An iteration that changes no files bumps a counter. The next prompt then gets a `PROGRESS CHECK` with a *mandatory lens* that rotates through twelve concrete directives — TESTS → CORRECTNESS → EDGE CASES → INTEGRATION → ROBUSTNESS → SECURITY → PERFORMANCE → ARCHITECTURE → MAINTAINABILITY → DOCUMENTATION → TODOs → ASSUMPTIONS — instead of repeating "continue" until the model reviews `README.md` for the 800th time.
- **Durable goal state.** The `autopilot_progress` tool lets the model record completed milestones, the current milestone, blockers and notes. Together with the automatic ledger this is injected into every continuation, so the conversation transcript is scratch space and the state is the memory. The tool cannot stop or pause anything.
- **Objective in the system prompt.** On autopilot turns a stable "AUTOPILOT MODE" block (objective + rules) is appended to the system prompt. It never changes during a goal, so it is prompt-cache friendly, and compaction cannot lose it.
- **Context management.** At ≥ 75 % context usage the harness triggers compaction with autopilot-aware instructions *before* injecting the next iteration. Pi's own compactions are tracked so nothing is injected into one.
- **Errors never stop it.** A run that ends in an error backs off exponentially (10 s → 5 min cap) and continues. If a turn cannot start at all (expired auth, no model) a liveness check notifies and re-sends with backoff.
- **Persistence.** State is stored as session entries (survives restart, `/resume`, `/fork`, `/tree`) and mirrored to `<cwd>/.pi/autopilot/state.json` and `AUTOPILOT.md` for humans and tools.
- **Restore semantics.** On startup, `--resume`, or fork a running goal is restored **PAUSED** — Pi never fires LLM turns on launch by itself; `/goal resume` continues. `/reload` keeps it running.

### What the model sees each iteration

```
AUTOPILOT ITERATION 17  (16 completed · running 2h 40m)

OBJECTIVE
Build a production-ready distributed job scheduler

STATE
Completed milestones: ✓ queue persistence · ✓ worker leasing · ✓ retries · ✓ heartbeat
Current milestone: Implement lease expiry recovery
Known blockers: none
User guidance (most recent last): "prefer sqlite over redis"
Recent iterations:
  #14 · 2 file(s): lease.ts, lease.test.ts · 3 cmd(s) · tests passing · Added lease_expires_at
  #15 · 1 file(s): lease.ts · 2 cmd(s) · tests passing · Added renewal transaction
  #16 · 1 file(s): lease.test.ts · 1 cmd(s) · tests passing · Added integration test
Files changed so far: 23 (latest: lease.ts, lease.test.ts, worker.ts, scheduler.ts, README.md)
Tests: passing (npm test)

DIRECTIVE
Continue working toward the objective. …
```

## Lifecycle

Exactly three states. Only the user moves between them.

| | RUNNING | PAUSED | STOPPED |
|---|---|---|---|
| `/goal <objective>` | asks, then restarts | asks, then restarts | starts |
| `/goal pause` | → PAUSED (run finishes) | – | – |
| `/goal resume` | – | → RUNNING | → RUNNING (state kept) |
| `/goal stop` | → STOPPED (aborts run) | → STOPPED | – |
| Esc during a run | → PAUSED | – | – |
| Error in a run | stays RUNNING, backs off | – | – |
| Restart / `--resume` / fork | → PAUSED | PAUSED | STOPPED |
| `/reload` | RUNNING | PAUSED | STOPPED |

There is no DONE state. If the model reports "the implementation is complete", the next iteration tells it to verify that conclusion by a different method, find the highest-value remaining gap, and act on it.

## Tuning

Constants at the top of [`autopilot.ts`](autopilot.ts):

| Constant | Default | Meaning |
|---|---|---|
| `COMPACT_AT_PERCENT` | `75` | Context usage that triggers compaction before the next iteration |
| `ERROR_BACKOFF_BASE_MS` / `ERROR_BACKOFF_CAP_MS` | `10 s` / `5 min` | Backoff after a run ends in an error |
| `LIVENESS_TIMEOUT_MS` | `60 s` | How long to wait for a turn to start before re-sending |
| `LIMITS` | – | How many recent actions, notes, guidance items, files and milestones are kept |
| `LENSES` | 12 entries | The rotation used when iterations stop changing files |

## Caveats

- `.pi/autopilot/` is written into the project you run Pi in. Add it to `.gitignore` if you don't want it committed.
- The `autopilot_progress` tool is always registered, so one conditional guideline line (~40 tokens) appears in every session's system prompt.
- Don't keep a second copy of `autopilot.ts` in `~/.pi/agent/extensions/` alongside an installed package. Both register the `autopilot_progress` tool, and Pi refuses to load the second one (`Tool "autopilot_progress" conflicts with …`), so `/goal` never appears. Keep one.
- Autopilot runs Pi's normal tools with Pi's normal permissions. It will keep editing, running commands and (if you ask it to) committing for as long as you leave it running. Point it at a branch or a worktree.

## Development

```bash
npm install
npm run typecheck   # tsc against Pi's real type definitions
npm test            # headless harness: loads autopilot.ts through jiti, drives the event lifecycle with mock timers
```

CI (`ci.yml`) runs typecheck + tests on Node 22 and 24. `security.yml` runs [OSV-Scanner](https://google.github.io/osv-scanner/) against `package-lock.json` on every push, PR and weekly; Dependabot opens grouped weekly bump PRs. Both are free and need no tokens.

Verify registration in real Pi without an LLM call:

```bash
printf '{"id":"1","type":"get_commands"}\n' | pi --mode rpc --no-session -ne -e . | grep -o '"name":"goal"[^}]*'
```

## License

MIT
