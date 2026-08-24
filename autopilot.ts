/**
 * pi-unstoppable — AUTOPILOT: a persistent goal-seeking runtime for Pi.
 *
 * https://github.com/YellowFoxH4XOR/pi-unstoppable
 *
 *   /goal <objective>    start (asks before replacing an active goal)
 *   /goal pause          stop injecting after the current run settles
 *   /goal resume         continue (from paused or stopped, state intact)
 *   /goal stop           terminate: abort the in-flight run, inject nothing more
 *   /goal status         inspect progress
 *   /goal note <text>    add durable guidance for future iterations
 *
 * Engine
 * ------
 * On every `agent_settled` — Pi has *nothing* left to do: no retry, no
 * compaction retry, no queued follow-up — the extension injects the next
 * iteration with `pi.sendUserMessage()`. There is no iteration cap, no
 * deadline, no context cap and no tool the model can call to end it. The
 * lifecycle has exactly three states, RUNNING / PAUSED / STOPPED, and only
 * the user moves between them. The model decides WHAT to do next; the
 * harness decides THAT it continues.
 *
 * Harness-owned behaviour (the parts a dumb loop gets wrong)
 * ----------------------------------------------------------
 * - Esc (Pi's `app.interrupt`) aborts the run and PAUSES autopilot so the
 *   user regains control; `/goal resume` continues.
 * - Runs that end in an error back off exponentially (10s → 5min cap).
 *   They never stop the loop.
 * - Every iteration is measured (files edited, commands run, test status,
 *   the model's own summary). Iterations that change no files bump a stall
 *   counter; the next prompt then rotates through concrete "lenses"
 *   (tests, correctness, security, performance, …) instead of repeating
 *   "continue" until the model reviews README.md for the 800th time.
 * - The objective + rules are appended to the system prompt on every
 *   autopilot turn (stable text → cache friendly); the mutable state block
 *   rides in each continuation message. Compaction can't lose either.
 * - Context usage ≥ 75% triggers compaction with autopilot-aware
 *   instructions *before* the next iteration is injected.
 * - State persists as session entries (survives restart, /resume, /fork)
 *   and mirrors to <cwd>/.pi/autopilot/{state.json,AUTOPILOT.md}.
 * - On startup / resume / fork a running autopilot is restored PAUSED — Pi
 *   never fires LLM turns on launch by itself. `/reload` keeps it running.
 * - A liveness check re-sends the continuation (with backoff) if a turn
 *   could not start (no model, expired auth, …). It keeps the loop alive;
 *   it never ends it.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_ENTRY = "autopilot-state";
const STATE_VERSION = 1;
const COMPACT_AT_PERCENT = 75;
const ERROR_BACKOFF_BASE_MS = 10_000;
const ERROR_BACKOFF_CAP_MS = 5 * 60_000;
const LIVENESS_TIMEOUT_MS = 60_000;
const COMPACTION_FALLBACK_MS = 10 * 60_000;
const RELOAD_RESUME_DELAY_MS = 750;
const LIMITS = { recentActions: 8, notes: 10, guidance: 6, files: 200, milestones: 60, blockers: 20 } as const;

type Phase = "running" | "paused" | "stopped";
type Outcome = "ok" | "aborted" | "error";
type StateEvent =
	| "start"
	| "iteration"
	| "pause"
	| "resume"
	| "stop"
	| "interrupted"
	| "restored"
	| "progress"
	| "guidance"
	| "compacted";

interface AutopilotState {
	version: number;
	phase: Phase;
	objective: string | null;
	startedAt: number | null;
	/** Completed iterations since /goal. */
	iteration: number;
	currentMilestone?: string;
	completedMilestones: string[];
	blockers: string[];
	notes: string[];
	userGuidance: string[];
	recentActions: string[];
	filesChanged: string[];
	testStatus?: string;
	lastProgressAt: number | null;
	/** Consecutive iterations that changed no files. */
	stalledIterations: number;
	consecutiveErrors: number;
	lastSummary?: string;
	totalToolCalls: number;
	compactions: number;
	updatedAt: number;
}

interface PersistedState extends AutopilotState {
	event: StateEvent;
}

interface IterationScratch {
	startedAt: number;
	toolCalls: number;
	files: Set<string>;
	commands: number;
	testStatus?: string;
}

/** Lenses rotated through when iterations stop producing changes. */
const LENSES: Array<{ name: string; directive: string }> = [
	{
		name: "TESTS",
		directive:
			"Run the full test suite. Find the least-tested module (coverage tooling, or by inspection) and add tests that exercise real behaviour: failure paths, boundaries, concurrency. A test that merely restates the implementation does not count.",
	},
	{
		name: "CORRECTNESS",
		directive:
			"Pick one non-trivial code path and trace it end-to-end by hand against the objective. Hunt for off-by-one errors, unhandled null/empty/timeout cases, wrong ordering, races, and swallowed errors. Fix what you find and prove it with a test.",
	},
	{
		name: "EDGE CASES",
		directive:
			"Enumerate boundary inputs: empty, huge, malformed, duplicate, out-of-order, unicode, clock skew, partial failure. Write a test for each one you cannot rule out; fix the failures.",
	},
	{
		name: "INTEGRATION",
		directive:
			"Exercise the system the way a real user would (CLI, API, end-to-end), not only through unit tests. Script it if needed. Fix whatever breaks or is awkward to use.",
	},
	{
		name: "ROBUSTNESS",
		directive:
			"Inject failure: kill a process mid-operation, drop a connection, corrupt or truncate persisted state, exhaust a resource. Make recovery correct and cover it with a test.",
	},
	{
		name: "SECURITY",
		directive:
			"Enumerate trust boundaries and inputs. Check injection, path traversal, secrets in logs or files, auth/authz gaps, unsafe deserialization, unbounded resource use. Fix concretely.",
	},
	{
		name: "PERFORMANCE",
		directive:
			"Measure, do not guess: profile or benchmark the hottest path. Fix one real bottleneck (algorithmic complexity, N+1, needless allocation, missing index or cache) and keep the benchmark.",
	},
	{
		name: "ARCHITECTURE",
		directive:
			"Find the module with the worst coupling or the leakiest abstraction. Refactor it into a cleaner boundary without changing behaviour; tests must stay green.",
	},
	{
		name: "MAINTAINABILITY",
		directive:
			"Remove duplication, dead code, misleading names and stale comments in one area. Make invariants explicit with assertions or types. Keep the change behaviour-preserving.",
	},
	{
		name: "DOCUMENTATION",
		directive:
			"Verify the docs against the code by actually following them (setup, usage, examples). Fix inaccuracies, document unstated invariants, add a missing runnable example.",
	},
	{
		name: "TODOs",
		directive:
			"grep for TODO, FIXME, XXX, HACK, unimplemented, panic, 'not implemented'. Resolve the most important one properly.",
	},
	{
		name: "ASSUMPTIONS",
		directive:
			"List the assumptions the implementation makes (environment, ordering, sizes, encoding, availability). Verify each by experiment or careful reading. Fix the ones that are false.",
	},
];

const TEST_CMD =
	/\b(pytest|vitest|jest|mocha|ava|cargo\s+test|go\s+test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+(run\s+)?test|bun\s+test|make\s+(test|check)|ctest|phpunit|rspec|dotnet\s+test|gradle\w*\s+test|mvn\s+test|swift\s+test|zig\s+test|deno\s+test|mix\s+test|tsc\b[^|&;]*--noEmit)\b/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function freshState(): AutopilotState {
	return {
		version: STATE_VERSION,
		phase: "stopped",
		objective: null,
		startedAt: null,
		iteration: 0,
		completedMilestones: [],
		blockers: [],
		notes: [],
		userGuidance: [],
		recentActions: [],
		filesChanged: [],
		lastProgressAt: null,
		stalledIterations: 0,
		consecutiveErrors: 0,
		totalToolCalls: 0,
		compactions: 0,
		updatedAt: Date.now(),
	};
}

function trunc(s: string, n: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
}

function pushCapped(arr: string[], item: string, max: number): void {
	arr.push(item);
	while (arr.length > max) arr.shift();
}

function addUnique(arr: string[], item: string, max: number): void {
	if (!arr.includes(item)) pushCapped(arr, item, max);
}

function fmtMs(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	if (h) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
	return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
}

function backoff(attempt: number): number {
	return Math.min(ERROR_BACKOFF_CAP_MS, ERROR_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => !!c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

/** Last paragraph of the assistant's final message, de-markdowned, truncated. */
function summarize(text: string, n = 160): string {
	const paras = text
		.split(/\n\s*\n/)
		.map((p) => p.replace(/^[\s#>*\-•]+/gm, "").trim())
		.filter(Boolean);
	return trunc(paras[paras.length - 1] ?? "", n);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function autopilot(pi: ExtensionAPI) {
	let state: AutopilotState = freshState();
	let iter: IterationScratch | undefined;
	let lastOutcome: Outcome = "ok";
	let lastError: string | undefined;
	let lastAssistantText = "";
	let continueTimer: ReturnType<typeof setTimeout> | undefined;
	let livenessTimer: ReturnType<typeof setTimeout> | undefined;
	let compactionTimer: ReturnType<typeof setTimeout> | undefined;
	let expectingStart = false;
	let sendFailures = 0;
	let compacting = false;
	let workingMessageSet = false;

	const isActive = () => state.phase === "running" && !!state.objective;
	const nextIteration = () => state.iteration + 1;

	// ----- infrastructure -----------------------------------------------------

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	}

	function clearTimers() {
		if (continueTimer) clearTimeout(continueTimer);
		if (livenessTimer) clearTimeout(livenessTimer);
		if (compactionTimer) clearTimeout(compactionTimer);
		continueTimer = livenessTimer = compactionTimer = undefined;
	}

	function persist(ctx: ExtensionContext, event: StateEvent) {
		state.updatedAt = Date.now();
		try {
			pi.appendEntry<PersistedState>(STATE_ENTRY, { ...state, event });
		} catch {
			// unbound runtime / ephemeral session — the on-disk mirror still works
		}
		mirrorToDisk(ctx.cwd);
	}

	function mirrorToDisk(cwd: string) {
		if (!state.objective) return;
		try {
			const dir = join(cwd, CONFIG_DIR_NAME, "autopilot");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
			writeFileSync(join(dir, "AUTOPILOT.md"), renderMarkdown());
		} catch {
			// best effort
		}
	}

	function renderMarkdown(): string {
		const list = (items: string[], empty: string, prefix = "- ") =>
			items.length ? items.map((i) => `${prefix}${i}`) : [empty];
		const lines = [
			"# AUTOPILOT",
			"",
			`**Status:** ${state.phase.toUpperCase()} · iteration ${state.iteration}` +
				(state.startedAt ? ` · started ${new Date(state.startedAt).toISOString()}` : ""),
			"",
			"## Objective",
			"",
			state.objective ?? "",
			"",
			"## Completed milestones",
			"",
			...list(state.completedMilestones, "_none recorded_", "- [x] "),
			"",
			"## Current milestone",
			"",
			state.currentMilestone ?? "_none_",
			"",
			"## Blockers",
			"",
			...list(state.blockers, "_none_"),
			"",
			"## Notes",
			"",
			...list(state.notes, "_none_"),
			"",
			"## User guidance",
			"",
			...list(state.userGuidance, "_none_"),
			"",
			"## Recent iterations",
			"",
			...list(state.recentActions, "_none yet_"),
			"",
			`## Files changed (${state.filesChanged.length})`,
			"",
			...list(state.filesChanged, "_none yet_", "- `").map((l) => (l.startsWith("- `") ? `${l}\`` : l)),
			"",
			"## Tests",
			"",
			state.testStatus ?? "_unknown_",
			"",
			`_Updated ${new Date(state.updatedAt).toISOString()} · ${state.totalToolCalls} tool calls · ${state.compactions} compactions_`,
			"",
		];
		return lines.join("\n");
	}

	// ----- UI -----------------------------------------------------------------

	function updateUi(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!state.objective || state.phase === "stopped") {
			ctx.ui.setStatus("autopilot", undefined);
			ctx.ui.setWidget("autopilot", undefined);
			return;
		}
		const phase = state.phase.toUpperCase();
		const n = state.phase === "running" ? nextIteration() : state.iteration;
		ctx.ui.setStatus("autopilot", `∞ AUTOPILOT ${phase} #${n}`);
		ctx.ui.setWidget("autopilot", widgetLines(ctx, phase, n), { placement: "aboveEditor" });
	}

	function widgetLines(ctx: ExtensionContext, phase: string, n: number): string[] {
		let th: Theme | undefined;
		try {
			th = ctx.ui.theme;
		} catch {
			th = undefined;
		}
		const fg = (c: string, s: string) => (th ? th.fg(c as Parameters<Theme["fg"]>[0], s) : s);
		const bold = (s: string) => (th ? th.bold(s) : s);
		const color = state.phase === "running" ? "success" : state.phase === "paused" ? "warning" : "error";
		const dot = fg(color, state.phase === "running" ? "●" : "◌");
		const elapsed = state.startedAt ? fmtMs(Date.now() - state.startedAt) : "";
		const stalled = state.stalledIterations >= 2 ? `  ${fg("warning", `stalled ×${state.stalledIterations}`)}` : "";
		const errors = state.consecutiveErrors ? `  ${fg("error", `errors ×${state.consecutiveErrors}`)}` : "";
		const lines = [
			`${dot} ${bold("AUTOPILOT")} ${fg(color, phase)}  ${fg("dim", `#${n}`)}${elapsed ? `  ${fg("dim", elapsed)}` : ""}${stalled}${errors}`,
			`  ${fg("dim", "Goal")}  ${trunc(state.objective ?? "", 100)}`,
		];
		if (state.currentMilestone) lines.push(`  ${fg("dim", "Now ")}  ${trunc(state.currentMilestone, 100)}`);
		const last = state.recentActions[state.recentActions.length - 1];
		if (last) lines.push(`  ${fg("dim", "Last")}  ${trunc(last, 100)}`);
		lines.push(`  ${fg("dim", "Esc interrupts (pauses) · /goal pause | resume | stop | status | note <text>")}`);
		return lines;
	}

	function setWorking(ctx: ExtensionContext, message?: string) {
		if (!ctx.hasUI) return;
		if (message) {
			ctx.ui.setWorkingMessage(message);
			workingMessageSet = true;
		} else if (workingMessageSet) {
			ctx.ui.setWorkingMessage();
			workingMessageSet = false;
		}
	}

	// ----- prompts ------------------------------------------------------------

	function stateBlock(): string {
		const L: string[] = [];
		L.push(
			`Completed milestones: ${
				state.completedMilestones.length
					? state.completedMilestones.map((m) => `✓ ${m}`).join(" · ")
					: "none recorded yet"
			}`,
		);
		L.push(
			`Current milestone: ${state.currentMilestone ?? "not set — decide one and record it with autopilot_progress"}`,
		);
		L.push(`Known blockers: ${state.blockers.length ? state.blockers.join(" · ") : "none"}`);
		if (state.notes.length) L.push(`Notes: ${state.notes.join(" · ")}`);
		if (state.userGuidance.length) {
			L.push(`User guidance (most recent last): ${state.userGuidance.map((g) => `"${g}"`).join(" · ")}`);
		}
		if (state.recentActions.length) {
			L.push("Recent iterations:");
			for (const a of state.recentActions) L.push(`  ${a}`);
		}
		L.push(
			`Files changed so far: ${state.filesChanged.length}${
				state.filesChanged.length
					? ` (latest: ${state.filesChanged
							.slice(-5)
							.map((f) => basename(f))
							.join(", ")})`
					: ""
			}`,
		);
		L.push(`Tests: ${state.testStatus ?? "unknown — run them"}`);
		return L.join("\n");
	}

	/** Stable per goal → appended to the system prompt on every autopilot turn. */
	function buildSystemBlock(): string {
		return `# AUTOPILOT MODE

You are running under AUTOPILOT: a harness that keeps sending you "continue" turns until the user explicitly ends it with /goal stop. You do not decide when it ends; you only decide what to do next.

PRIMARY OBJECTIVE:
${state.objective}

Rules:
1. Inspect the repository and determine the real current state before acting. Trust files and command output over memory.
2. Choose the highest-value next action toward the objective and execute it with tools. Prefer concrete progress over commentary.
3. Verify your work: run the tests, run the program, check behaviour. Keep the software working at every step.
4. Never stop because a task, milestone, or the whole implementation appears complete. Re-read the objective and find the next meaningful gap: correctness, tests, edge cases, integration, robustness, maintainability, architecture, performance, security, documentation, TODOs, unverified assumptions.
5. If you conclude there is nothing left to do, verify that conclusion by a different method (run everything, re-read the objective, try to break it) and act on what you find.
6. Do not ask the user what to do next; decide yourself. Do not wait for user messages. If the user does type something, treat it as guidance and keep going.
7. Record progress with the autopilot_progress tool (milestones, blockers, notes). It never stops autopilot; only the user can.
8. Finish each iteration with a brief summary of what changed and what comes next.`;
	}

	function buildInitialPrompt(): string {
		return `AUTOPILOT MODE IS ACTIVE.

PRIMARY OBJECTIVE:
${state.objective}

Work autonomously toward this objective. Start by inspecting the current repository and state, decide the highest-value first action, and execute it. Verify your work. Before you finish this iteration, call autopilot_progress with a current_milestone so future iterations know the plan.

Do not stop when something appears complete: the harness keeps going until the user issues /goal stop. Do not ask what to do next.

Begin now.`;
	}

	function buildContinuationPrompt(): string {
		const n = nextIteration();
		const elapsed = state.startedAt ? fmtMs(Date.now() - state.startedAt) : "0s";
		const parts: string[] = [];
		parts.push(`AUTOPILOT ITERATION ${n}  (${state.iteration} completed · running ${elapsed})`);
		parts.push("");
		parts.push("OBJECTIVE");
		parts.push(state.objective ?? "");
		parts.push("");
		parts.push("STATE");
		parts.push(stateBlock());
		parts.push("");
		parts.push("DIRECTIVE");
		parts.push(
			"Continue working toward the objective. Re-evaluate the repository and everything accomplished so far, identify the highest-value remaining action, and execute it now. Verify your work.",
		);
		parts.push("");
		parts.push(
			"Do NOT stop merely because the previous task finished, tests pass, the requested feature appears implemented, or you believe the project is done. If the core objective appears satisfied, actively hunt for remaining gaps in correctness, tests, edge cases, integration, robustness, maintainability, architecture, performance, security, documentation, unfinished TODOs and unverified assumptions — then fix one concretely.",
		);
		if (state.consecutiveErrors > 0) {
			parts.push("");
			parts.push(
				`NOTE: the previous ${state.consecutiveErrors === 1 ? "iteration" : `${state.consecutiveErrors} iterations`} ended with an error${
					lastError ? ` (${trunc(lastError, 160)})` : ""
				}. Check what was left half-done, keep your responses and tool outputs smaller, and continue.`,
			);
		}
		if (state.stalledIterations > 0) {
			const lens = LENSES[(state.stalledIterations - 1) % LENSES.length];
			parts.push("");
			parts.push(
				`PROGRESS CHECK: the last ${
					state.stalledIterations === 1 ? "iteration" : `${state.stalledIterations} iterations`
				} changed no files. Reading and re-reviewing is not progress. This iteration's mandatory lens is ${lens.name}: ${lens.directive} End this iteration with at least one concrete change (code, test, doc or config), or a written, verified proof that none is needed under this lens — then move to a different area next time.`,
			);
		}
		parts.push("");
		parts.push(
			"Before finishing, call autopilot_progress to record what you completed, what is next, and any blockers. Do not ask the user what to do next and do not wait for another user message. AUTOPILOT continues until the user issues /goal stop.",
		);
		return parts.join("\n");
	}

	function compactionInstructions(): string {
		return `This session runs under AUTOPILOT toward a long-lived objective. Preserve, verbatim where possible:
- the AUTOPILOT objective: ${JSON.stringify(state.objective)}
- architecture and design decisions made, with their reasons
- completed milestones, the current milestone, and known blockers
- failing tests and unresolved problems, with exact error messages
- important commands (build, test, run) and relevant file paths
- guidance the user gave during the run
Remove redundant tool output and superseded conversation.`;
	}

	// ----- engine -------------------------------------------------------------

	function schedule(ctx: ExtensionContext, delayMs: number) {
		if (continueTimer) clearTimeout(continueTimer);
		continueTimer = setTimeout(
			() => {
				continueTimer = undefined;
				fire(ctx);
			},
			Math.max(0, delayMs),
		);
	}

	function fire(ctx: ExtensionContext) {
		if (!isActive()) return;
		if (compacting) return; // compaction completion re-schedules
		if (!ctx.isIdle()) return; // a run is in flight; its settle re-enters the engine
		send(ctx, buildContinuationPrompt(), false);
	}

	function send(ctx: ExtensionContext, prompt: string, queue: boolean) {
		expectingStart = true;
		armLiveness(ctx);
		try {
			pi.sendUserMessage(prompt, queue ? { deliverAs: "followUp" } : undefined);
		} catch (err) {
			onSendFailure(ctx, err);
		}
	}

	function armLiveness(ctx: ExtensionContext) {
		if (livenessTimer) clearTimeout(livenessTimer);
		livenessTimer = setTimeout(() => {
			livenessTimer = undefined;
			if (!expectingStart || !isActive()) return;
			if (compacting || !ctx.isIdle()) {
				armLiveness(ctx); // something is happening; keep waiting
				return;
			}
			onSendFailure(ctx, new Error(`the agent did not start within ${fmtMs(LIVENESS_TIMEOUT_MS)}`));
		}, LIVENESS_TIMEOUT_MS);
	}

	function onSendFailure(ctx: ExtensionContext, err: unknown) {
		expectingStart = false;
		sendFailures++;
		const delay = backoff(sendFailures);
		const reason = err instanceof Error ? err.message : String(err);
		notify(
			ctx,
			`Autopilot could not start iteration ${nextIteration()}: ${trunc(reason, 140)}. Retrying in ${fmtMs(delay)}. Check /model and /login; /goal pause to hold.`,
			"error",
		);
		schedule(ctx, delay);
	}

	function newScratch(): IterationScratch {
		return { startedAt: Date.now(), toolCalls: 0, files: new Set(), commands: 0 };
	}

	function finalizeIteration() {
		const s = iter ?? newScratch();
		iter = undefined;
		state.iteration++;
		const changed = s.files.size > 0;
		if (changed) {
			state.stalledIterations = 0;
			state.lastProgressAt = Date.now();
			for (const f of s.files) addUnique(state.filesChanged, f, LIMITS.files);
		} else {
			state.stalledIterations++;
		}
		if (s.testStatus) state.testStatus = s.testStatus;
		state.totalToolCalls += s.toolCalls;
		state.lastSummary = summarize(lastAssistantText) || undefined;

		const parts = [`#${state.iteration}`];
		if (lastOutcome !== "ok") parts.push(lastOutcome);
		if (changed) {
			const names = [...s.files].slice(0, 3).map((f) => basename(f));
			parts.push(`${s.files.size} file(s): ${names.join(", ")}${s.files.size > 3 ? ", …" : ""}`);
		} else {
			parts.push("no file changes");
		}
		if (s.commands) parts.push(`${s.commands} cmd(s)`);
		if (s.testStatus) parts.push(`tests ${s.testStatus.split(" ")[0]}`);
		if (state.lastSummary) parts.push(state.lastSummary);
		pushCapped(state.recentActions, trunc(parts.join(" · "), 220), LIMITS.recentActions);
	}

	function maybeCompactThen(ctx: ExtensionContext, next: () => void) {
		let pct: number | null = null;
		try {
			pct = ctx.getContextUsage()?.percent ?? null;
		} catch {
			pct = null;
		}
		if (pct === null || pct < COMPACT_AT_PERCENT || compacting) {
			next();
			return;
		}
		compacting = true;
		notify(ctx, `Context at ${Math.round(pct)}% — compacting before iteration ${nextIteration()}.`, "info");
		let done = false;
		const finish = (ok: boolean) => {
			if (done) return;
			done = true;
			compacting = false;
			if (compactionTimer) clearTimeout(compactionTimer);
			compactionTimer = undefined;
			if (ok) {
				state.compactions++;
				persist(ctx, "compacted");
			}
			next();
		};
		compactionTimer = setTimeout(() => finish(false), COMPACTION_FALLBACK_MS);
		try {
			ctx.compact({
				customInstructions: compactionInstructions(),
				onComplete: () => finish(true),
				onError: (error) => {
					notify(ctx, `Compaction failed: ${trunc(error.message, 140)} — continuing anyway.`, "warning");
					finish(false);
				},
			});
		} catch (err) {
			notify(ctx, `Compaction could not start: ${trunc(String(err), 140)} — continuing anyway.`, "warning");
			finish(false);
		}
	}

	/** THE ENGINE. Pi is fully idle; decide what happens next. */
	pi.on("agent_settled", async (_event, ctx) => {
		setWorking(ctx);
		if (!isActive()) {
			iter = undefined;
			return;
		}
		finalizeIteration();

		if (lastOutcome === "aborted") {
			state.phase = "paused";
			state.consecutiveErrors = 0;
			persist(ctx, "interrupted");
			updateUi(ctx);
			notify(
				ctx,
				`Autopilot paused after interrupt (iteration ${state.iteration}). /goal resume to continue, /goal stop to end.`,
				"warning",
			);
			return;
		}

		let delay = 0;
		if (lastOutcome === "error") {
			state.consecutiveErrors++;
			delay = backoff(state.consecutiveErrors);
			notify(
				ctx,
				`Iteration ${state.iteration} ended with an error${lastError ? `: ${trunc(lastError, 120)}` : ""}. Retrying in ${fmtMs(delay)} (attempt ${state.consecutiveErrors}). Autopilot does not stop on errors — /goal pause or /goal stop to intervene.`,
				"warning",
			);
		} else {
			state.consecutiveErrors = 0;
		}
		persist(ctx, "iteration");
		updateUi(ctx);
		maybeCompactThen(ctx, () => schedule(ctx, delay));
	});

	pi.on("agent_start", async (_event, ctx) => {
		expectingStart = false;
		sendFailures = 0;
		if (livenessTimer) clearTimeout(livenessTimer);
		livenessTimer = undefined;
		lastOutcome = "ok";
		lastError = undefined;
		if (!iter) iter = newScratch(); // keep scratch across retries / compaction retries
		if (isActive()) setWorking(ctx, `∞ autopilot #${nextIteration()}`);
	});

	pi.on("agent_end", async (event) => {
		const msgs = (event.messages ?? []) as unknown as Array<Record<string, unknown>>;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (!m || m.role !== "assistant") continue;
			lastOutcome = m.stopReason === "aborted" ? "aborted" : m.stopReason === "error" ? "error" : "ok";
			lastError = typeof m.errorMessage === "string" ? m.errorMessage : undefined;
			lastAssistantText = extractText(m.content);
			break;
		}
	});

	// tool_execution_end carries no args; remember them from tool_execution_start.
	const toolArgs = new Map<string, Record<string, unknown>>();
	pi.on("tool_execution_start", async (event) => {
		if (!isActive()) return;
		if (toolArgs.size > 64) toolArgs.clear();
		toolArgs.set(event.toolCallId, (event.args ?? {}) as Record<string, unknown>);
	});

	pi.on("tool_execution_end", async (event) => {
		const args = toolArgs.get(event.toolCallId) ?? {};
		toolArgs.delete(event.toolCallId);
		if (!isActive()) return;
		if (!iter) iter = newScratch();
		iter.toolCalls++;
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			if (typeof args.path === "string") iter.files.add(args.path);
		} else if (event.toolName === "bash") {
			iter.commands++;
			if (typeof args.command === "string" && TEST_CMD.test(args.command)) {
				iter.testStatus = `${event.isError ? "failing" : "passing"} (${trunc(args.command, 48)})`;
			}
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!isActive()) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildSystemBlock()}` };
	});

	/** Anything the user types while autopilot runs becomes durable guidance. */
	pi.on("input", async (event, ctx) => {
		if (!isActive() || event.source === "extension") return;
		const text = event.text.trim();
		if (!text || text.startsWith("/") || text.startsWith("!")) return;
		pushCapped(state.userGuidance, trunc(text, 300), LIMITS.guidance);
		persist(ctx, "guidance");
	});

	// Track Pi's own compactions so we never inject into one.
	pi.on("session_before_compact", async () => {
		compacting = true;
	});
	pi.on("session_compact", async (_event, ctx) => {
		compacting = false;
		if (isActive() && ctx.isIdle() && !expectingStart && !continueTimer) schedule(ctx, 0);
	});

	// ----- persistence / lifecycle -------------------------------------------

	function restore(ctx: ExtensionContext, reason: string) {
		clearTimers();
		compacting = false;
		expectingStart = false;
		iter = undefined;
		state = freshState();

		let found: PersistedState | undefined;
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "custom" && e.customType === STATE_ENTRY && e.data && typeof e.data === "object") {
				found = e.data as PersistedState;
				break;
			}
		}
		if (!found || found.version !== STATE_VERSION || !found.objective) {
			updateUi(ctx);
			return;
		}
		const { event: _event, ...rest } = found;
		state = { ...freshState(), ...rest };

		if (state.phase === "running") {
			if (reason === "reload") {
				notify(ctx, `Autopilot still running after reload (iteration ${state.iteration}).`, "info");
				if (ctx.isIdle()) schedule(ctx, RELOAD_RESUME_DELAY_MS);
			} else {
				state.phase = "paused";
				persist(ctx, "restored");
				notify(
					ctx,
					`Autopilot was RUNNING (iteration ${state.iteration}) when this session last ran — restored PAUSED. /goal resume to continue, /goal stop to end.`,
					"warning",
				);
			}
		}
		updateUi(ctx);
	}

	pi.on("session_start", async (event, ctx) => restore(ctx, event.reason));
	pi.on("session_tree", async (_event, ctx) => restore(ctx, "tree"));
	pi.on("session_shutdown", async (_event, ctx) => {
		clearTimers();
		mirrorToDisk(ctx.cwd);
	});

	pi.registerEntryRenderer<PersistedState>(STATE_ENTRY, (entry, _options, theme) => {
		const d = entry.data;
		if (!d) return undefined;
		let text: string;
		switch (d.event) {
			case "start":
				text = `∞ autopilot started · ${trunc(d.objective ?? "", 90)}`;
				break;
			case "iteration":
				text = `∞ autopilot ${d.recentActions[d.recentActions.length - 1] ?? `#${d.iteration}`}`;
				break;
			case "pause":
				text = `∞ autopilot paused at #${d.iteration}`;
				break;
			case "interrupted":
				text = `∞ autopilot interrupted — paused at #${d.iteration}`;
				break;
			case "resume":
				text = `∞ autopilot resumed at #${d.iteration}`;
				break;
			case "stop":
				text = `∞ autopilot stopped after ${d.iteration} iteration(s)`;
				break;
			case "restored":
				text = `∞ autopilot restored paused at #${d.iteration}`;
				break;
			default:
				return undefined;
		}
		return new Text(theme.fg("dim", text), 0, 0);
	});

	// ----- progress tool (records state; can NOT stop autopilot) --------------

	pi.registerTool({
		name: "autopilot_progress",
		label: "Autopilot Progress",
		description:
			"Record AUTOPILOT progress: a completed milestone, the current milestone, a blocker, a resolved blocker, or a durable note. The harness injects this state into every future iteration and it survives compaction, so use it instead of relying on conversation memory. This tool never stops or pauses autopilot — only the user can, with /goal stop.",
		promptSnippet: "Record autopilot milestones, blockers and notes (never stops autopilot)",
		promptGuidelines: [
			"When AUTOPILOT mode is active, call autopilot_progress at the end of each iteration to record what was completed, what is next, and any blockers.",
		],
		parameters: Type.Object({
			completed_milestone: Type.Optional(Type.String({ description: "A milestone you just finished and verified" })),
			current_milestone: Type.Optional(Type.String({ description: "What you are working on now / next" })),
			blocker: Type.Optional(Type.String({ description: "A blocker future iterations must know about" })),
			resolved_blocker: Type.Optional(
				Type.String({ description: "Text of a previously recorded blocker that is now resolved" }),
			),
			note: Type.Optional(
				Type.String({ description: "A short durable note for future iterations (decision, command, gotcha)" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.objective) {
				return {
					content: [{ type: "text", text: "Autopilot is not active; nothing recorded." }],
					details: { recorded: [] },
				};
			}
			const recorded: string[] = [];
			if (params.completed_milestone) {
				const m = trunc(params.completed_milestone, 200);
				addUnique(state.completedMilestones, m, LIMITS.milestones);
				if (state.currentMilestone && state.currentMilestone.toLowerCase() === m.toLowerCase()) {
					state.currentMilestone = undefined;
				}
				recorded.push(`completed "${m}"`);
			}
			if (params.current_milestone) {
				state.currentMilestone = trunc(params.current_milestone, 200);
				recorded.push(`current → "${state.currentMilestone}"`);
			}
			if (params.resolved_blocker) {
				const needle = params.resolved_blocker.trim().toLowerCase();
				const before = state.blockers.length;
				state.blockers = state.blockers.filter(
					(b) => !(b.toLowerCase() === needle || b.toLowerCase().includes(needle) || needle.includes(b.toLowerCase())),
				);
				recorded.push(before !== state.blockers.length ? `resolved blocker "${trunc(params.resolved_blocker, 120)}"` : "no matching blocker to resolve");
			}
			if (params.blocker) {
				addUnique(state.blockers, trunc(params.blocker, 200), LIMITS.blockers);
				recorded.push(`blocker "${trunc(params.blocker, 120)}"`);
			}
			if (params.note) {
				pushCapped(state.notes, trunc(params.note, 240), LIMITS.notes);
				recorded.push("note");
			}
			persist(ctx, "progress");
			updateUi(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Recorded: ${recorded.join("; ") || "nothing (no fields given)"}.\n\n${stateBlock()}\n\nAutopilot continues until the user issues /goal stop.`,
					},
				],
				details: {
					recorded,
					iteration: state.iteration,
					currentMilestone: state.currentMilestone,
					completedMilestones: [...state.completedMilestones],
					blockers: [...state.blockers],
				},
			};
		},

		renderCall(args, theme) {
			const bits: string[] = [];
			if (args.completed_milestone) bits.push(`✓ ${trunc(args.completed_milestone, 60)}`);
			if (args.current_milestone) bits.push(`→ ${trunc(args.current_milestone, 60)}`);
			if (args.blocker) bits.push(`⚠ ${trunc(args.blocker, 60)}`);
			if (args.resolved_blocker) bits.push(`✔ resolved ${trunc(args.resolved_blocker, 40)}`);
			if (args.note) bits.push(`✎ ${trunc(args.note, 60)}`);
			return new Text(
				theme.fg("toolTitle", theme.bold("autopilot_progress ")) + theme.fg("muted", bits.join("  ") || "(no fields)"),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { recorded?: string[] } | undefined;
			const recorded = details?.recorded ?? [];
			return new Text(
				recorded.length
					? theme.fg("success", "✓ ") + theme.fg("muted", recorded.join("; "))
					: theme.fg("dim", "nothing recorded"),
				0,
				0,
			);
		},
	});

	// ----- /goal command ------------------------------------------------------

	function statusText(): string {
		const running = state.phase === "running";
		const elapsed = state.startedAt ? fmtMs(Date.now() - state.startedAt) : "0s";
		const lines = [
			`∞ AUTOPILOT ${state.phase.toUpperCase()} · ${state.iteration} iteration(s) completed${
				running ? ` · working on #${nextIteration()}` : ""
			} · ${elapsed}`,
			`Goal: ${trunc(state.objective ?? "", 200)}`,
			`Current: ${state.currentMilestone ?? "—"}`,
			`Completed: ${state.completedMilestones.length}${
				state.completedMilestones.length
					? ` (last: ${trunc(state.completedMilestones[state.completedMilestones.length - 1], 80)})`
					: ""
			}`,
			`Blockers: ${state.blockers.length ? state.blockers.map((b) => trunc(b, 60)).join(" · ") : "none"}`,
			`Files changed: ${state.filesChanged.length} · Tests: ${state.testStatus ?? "unknown"} · Tool calls: ${
				state.totalToolCalls
			} · Compactions: ${state.compactions}`,
			`Stalled: ${state.stalledIterations} · Errors in a row: ${state.consecutiveErrors}`,
		];
		const last = state.recentActions[state.recentActions.length - 1];
		if (last) lines.push(`Last: ${trunc(last, 160)}`);
		lines.push(`Mirror: ${CONFIG_DIR_NAME}/autopilot/AUTOPILOT.md`);
		return lines.join("\n");
	}

	function usageText(): string {
		const status = state.objective ? `\n\n${statusText()}` : "\n\nNo goal set.";
		return `Usage: /goal <objective> | pause | resume | stop | status | note <text>${status}`;
	}

	async function startGoal(ctx: ExtensionCommandContext, objective: string) {
		if (state.objective && state.phase !== "stopped" && ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"Replace autopilot goal?",
				`Current goal (${state.phase}, iteration ${state.iteration}):\n${trunc(state.objective, 200)}\n\nReplace with:\n${trunc(objective, 200)}\n\nProgress state will be reset.`,
			);
			if (!ok) {
				notify(ctx, "Kept the current goal.", "info");
				return;
			}
		}
		clearTimers();
		compacting = false;
		iter = undefined;
		sendFailures = 0;
		state = { ...freshState(), phase: "running", objective, startedAt: Date.now() };
		persist(ctx, "start");
		updateUi(ctx);
		try {
			if (!pi.getSessionName()) pi.setSessionName(`autopilot: ${trunc(objective, 48)}`);
		} catch {
			// naming is cosmetic
		}
		const queue = !ctx.isIdle();
		send(ctx, buildInitialPrompt(), queue);
		notify(
			ctx,
			queue
				? "Autopilot armed — starts when the current run finishes. Esc pauses; /goal stop ends it."
				: "Autopilot engaged. Esc pauses; /goal stop ends it.",
			"info",
		);
	}

	pi.registerCommand("goal", {
		description: "Autopilot: /goal <objective> | pause | resume | stop | status | note <text>",
		getArgumentCompletions: (prefix) => {
			const subs = ["pause", "resume", "stop", "status", "note "];
			const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s.trim() }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			const word = input.split(/\s+/)[0]?.toLowerCase() ?? "";

			if (!input || input === "help") {
				notify(ctx, usageText(), "info");
				return;
			}

			if (input === "status") {
				notify(ctx, state.objective ? statusText() : "Autopilot inactive. /goal <objective> to start.", "info");
				return;
			}

			if (input === "pause") {
				if (!state.objective || state.phase === "stopped") {
					notify(ctx, "No active goal to pause.", "warning");
					return;
				}
				if (state.phase === "paused") {
					notify(ctx, "Autopilot is already paused.", "info");
					return;
				}
				state.phase = "paused";
				clearTimers();
				expectingStart = false;
				persist(ctx, "pause");
				updateUi(ctx);
				notify(
					ctx,
					ctx.isIdle()
						? "Autopilot paused. /goal resume to continue."
						: "Autopilot paused — the current run finishes, then nothing more is injected (Esc aborts it now). /goal resume to continue.",
					"info",
				);
				return;
			}

			if (input === "resume") {
				if (!state.objective) {
					notify(ctx, "No goal to resume. Start one with /goal <objective>.", "error");
					return;
				}
				if (state.phase === "running") {
					notify(ctx, "Autopilot is already running.", "info");
					return;
				}
				state.phase = "running";
				state.consecutiveErrors = 0;
				sendFailures = 0;
				persist(ctx, "resume");
				updateUi(ctx);
				if (ctx.isIdle()) {
					schedule(ctx, 0);
					notify(ctx, `Autopilot resumed (iteration ${nextIteration()}).`, "info");
				} else {
					notify(ctx, "Autopilot resumed — continues when the current run settles.", "info");
				}
				return;
			}

			if (input === "stop") {
				if (!state.objective || state.phase === "stopped") {
					notify(ctx, "Autopilot is not running.", "info");
					return;
				}
				const wasIdle = ctx.isIdle();
				state.phase = "stopped";
				clearTimers();
				compacting = false;
				expectingStart = false;
				iter = undefined;
				if (!wasIdle) {
					try {
						ctx.abort();
					} catch {
						// nothing to abort
					}
				}
				persist(ctx, "stop");
				updateUi(ctx);
				setWorking(ctx);
				notify(
					ctx,
					`Autopilot stopped after ${state.iteration} iteration(s)${
						wasIdle ? "" : " (aborted the in-flight run)"
					}. /goal resume restarts from this state; /goal <objective> starts fresh.`,
					"info",
				);
				return;
			}

			if (word === "note") {
				const text = input.slice(4).trim();
				if (!text) {
					notify(ctx, "Usage: /goal note <guidance for future iterations>", "warning");
					return;
				}
				if (!state.objective) {
					notify(ctx, "No active goal. Start one with /goal <objective>.", "error");
					return;
				}
				pushCapped(state.userGuidance, trunc(text, 300), LIMITS.guidance);
				persist(ctx, "guidance");
				notify(ctx, "Noted — injected into the next iteration.", "info");
				return;
			}

			await startGoal(ctx, input);
		},
	});
}
