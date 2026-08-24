// Headless harness: loads autopilot.ts through jiti (the same loader Pi uses),
// drives it with a fake ExtensionAPI / ExtensionContext and Node's mock timers,
// and asserts the harness semantics end to end. No LLM, no Pi process.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "autopilot.ts");
const CWD = join(ROOT, "test", ".tmp-project");

// pi-coding-agent only declares "import"/"types" export conditions → resolve as ESM.
const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const { createJiti } = require(require.resolve("jiti", { paths: [piRoot, ROOT] }));

test("autopilot", async (t) => {
	rmSync(CWD, { recursive: true, force: true });
	mkdirSync(CWD, { recursive: true });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const tick = (ms) => t.mock.timers.tick(ms);

	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const mod = await jiti.import(EXT);
	const factory = mod.default ?? mod;
	assert.equal(typeof factory, "function", "extension must export a default factory");

	// ---- fake ExtensionAPI ----------------------------------------------------
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const renderers = new Map();
	const sent = [];
	const entries = [];
	let sessionName;
	const pi = {
		on: (ev, h) => {
			if (!handlers.has(ev)) handlers.set(ev, []);
			handlers.get(ev).push(h);
		},
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerEntryRenderer: (type, r) => renderers.set(type, r),
		sendUserMessage: (content, options) => sent.push({ content, options }),
		appendEntry: (customType, data) =>
			entries.push({ type: "custom", customType, data: structuredClone(data), id: String(entries.length) }),
		setSessionName: (n) => {
			sessionName = n;
		},
		getSessionName: () => sessionName,
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		events: {},
	};
	factory(pi);

	const theme = { fg: (_c, s) => s, bold: (s) => s };
	function makeCtx(over = {}) {
		const ui = {
			notifications: [],
			statuses: {},
			widgets: {},
			working: [],
			theme,
			notify: (m, type) => ui.notifications.push({ m, type }),
			setStatus: (k, v) => (ui.statuses[k] = v),
			setWidget: (k, v) => (ui.widgets[k] = v),
			setWorkingMessage: (m) => ui.working.push(m),
			confirm: async () => true,
		};
		const ctx = {
			ui,
			hasUI: true,
			mode: "tui",
			cwd: CWD,
			sessionManager: { getBranch: () => entries },
			idle: true,
			aborted: 0,
			compactCalls: [],
			usage: undefined,
			isIdle() {
				return ctx.idle;
			},
			abort() {
				ctx.aborted++;
			},
			hasPendingMessages: () => false,
			getContextUsage: () => ctx.usage,
			compact: (opts) => ctx.compactCalls.push(opts),
			...over,
		};
		return ctx;
	}
	async function emit(ev, event, ctx) {
		let result;
		for (const h of handlers.get(ev) ?? []) {
			const r = await h(event, ctx);
			if (r !== undefined) result = r;
		}
		return result;
	}
	let toolCounter = 0;
	async function run(ctx, { files = [], cmds = [], text = "Done.", stopReason = "stop", errorMessage } = {}) {
		ctx.idle = false;
		await emit("agent_start", { type: "agent_start" }, ctx);
		for (const f of files) {
			const id = `t${++toolCounter}`;
			await emit("tool_execution_start", { type: "tool_execution_start", toolCallId: id, toolName: "edit", args: { path: f } }, ctx);
			await emit("tool_execution_end", { type: "tool_execution_end", toolCallId: id, toolName: "edit", result: {}, isError: false }, ctx);
		}
		for (const c of cmds) {
			const id = `t${++toolCounter}`;
			await emit("tool_execution_start", { type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: c.cmd } }, ctx);
			await emit("tool_execution_end", { type: "tool_execution_end", toolCallId: id, toolName: "bash", result: {}, isError: !!c.fail }, ctx);
		}
		await emit(
			"agent_end",
			{ type: "agent_end", messages: [{ role: "user", content: [] }, { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage }] },
			ctx,
		);
		ctx.idle = true;
		await emit("agent_settled", { type: "agent_settled" }, ctx);
	}
	const goal = (ctx, args) => commands.get("goal").handler(args, ctx);
	const lastState = () => entries.filter((e) => e.customType === "autopilot-state").at(-1)?.data;
	const lastSent = () => sent.at(-1)?.content ?? "";
	const lastNotice = (ctx) => ctx.ui.notifications.at(-1)?.m ?? "";

	// ---- tests ----------------------------------------------------------------
	await t.test("registers /goal, autopilot_progress and the lifecycle handlers", () => {
		assert.ok(commands.has("goal"));
		assert.ok(tools.has("autopilot_progress"));
		assert.ok(renderers.has("autopilot-state"));
		for (const ev of [
			"agent_settled", "agent_start", "agent_end", "tool_execution_start", "tool_execution_end",
			"before_agent_start", "input", "session_start", "session_shutdown", "session_before_compact", "session_compact",
		]) {
			assert.ok(handlers.has(ev), `missing handler ${ev}`);
		}
	});

	const ctx = makeCtx();
	await emit("session_start", { type: "session_start", reason: "startup" }, ctx);

	await t.test("fresh session is inactive", () => {
		assert.equal(ctx.ui.statuses.autopilot, undefined);
		assert.equal(sent.length, 0);
	});

	await goal(ctx, "Build a production-ready distributed job scheduler");

	await t.test("/goal sends the initial prompt, persists RUNNING, shows the widget, mirrors to disk", () => {
		assert.equal(sent.length, 1);
		assert.match(lastSent(), /AUTOPILOT MODE IS ACTIVE/);
		assert.match(lastSent(), /distributed job scheduler/);
		assert.equal(sent[0].options, undefined, "idle → not queued");
		assert.equal(lastState().phase, "running");
		assert.equal(lastState().event, "start");
		assert.match(ctx.ui.statuses.autopilot, /RUNNING #1/);
		assert.ok(Array.isArray(ctx.ui.widgets.autopilot) && ctx.ui.widgets.autopilot.length >= 3);
		assert.match(sessionName, /^autopilot:/);
		assert.ok(existsSync(join(CWD, ".pi/autopilot/state.json")));
		assert.ok(existsSync(join(CWD, ".pi/autopilot/AUTOPILOT.md")));
	});

	await t.test("before_agent_start appends the AUTOPILOT block to the system prompt", async () => {
		const r = await emit("before_agent_start", { type: "before_agent_start", prompt: "x", systemPrompt: "BASE", systemPromptOptions: {} }, ctx);
		assert.ok(r?.systemPrompt.startsWith("BASE\n\n# AUTOPILOT MODE"));
		assert.match(r.systemPrompt, /distributed job scheduler/);
	});

	await run(ctx, { files: ["src/lease.ts", "src/lease.test.ts"], cmds: [{ cmd: "npm test" }], text: "Summary.\n\nAdded lease renewal + tests." });

	await t.test("agent_settled finalizes the iteration and schedules (does not send synchronously)", () => {
		assert.equal(lastState().iteration, 1);
		assert.equal(lastState().stalledIterations, 0);
		assert.deepEqual(lastState().filesChanged, ["src/lease.ts", "src/lease.test.ts"]);
		assert.match(lastState().testStatus, /^passing/);
		assert.match(lastState().recentActions.at(-1), /#1 · 2 file\(s\): lease.ts, lease.test.ts · 1 cmd\(s\) · tests passing · Added lease renewal \+ tests\./);
		assert.equal(sent.length, 1);
	});

	tick(1);

	await t.test("continuation #2 carries the state block", () => {
		assert.equal(sent.length, 2);
		assert.match(lastSent(), /^AUTOPILOT ITERATION 2/);
		assert.match(lastSent(), /Files changed so far: 2 \(latest: lease.ts, lease.test.ts\)/);
		assert.match(lastSent(), /Tests: passing \(npm test\)/);
		assert.match(lastSent(), /Added lease renewal \+ tests/);
		assert.doesNotMatch(lastSent(), /PROGRESS CHECK/);
		assert.match(ctx.ui.statuses.autopilot, /RUNNING #2/);
	});

	await t.test("autopilot_progress records milestones and blockers", async () => {
		const tool = tools.get("autopilot_progress");
		const r = await tool.execute("id", { completed_milestone: "queue persistence", current_milestone: "worker leasing", blocker: "no redis in CI" }, undefined, undefined, ctx);
		assert.match(r.content[0].text, /Recorded: completed "queue persistence"; current → "worker leasing"; blocker "no redis in CI"/);
		assert.deepEqual(lastState().completedMilestones, ["queue persistence"]);
		assert.equal(lastState().currentMilestone, "worker leasing");
		assert.match(ctx.ui.widgets.autopilot.join("\n"), /Now.*worker leasing/);
		const r2 = await tool.execute("id", { resolved_blocker: "redis in CI", completed_milestone: "worker leasing" }, undefined, undefined, ctx);
		assert.match(r2.content[0].text, /resolved blocker/);
		assert.deepEqual(lastState().blockers, []);
		assert.equal(lastState().currentMilestone, undefined, "completing the current milestone clears it");
	});

	await t.test("typed input becomes guidance; extension-injected and slash input are ignored", async () => {
		await emit("input", { type: "input", text: "focus on tests first", source: "interactive" }, ctx);
		await emit("input", { type: "input", text: "AUTOPILOT ITERATION 3 ...", source: "extension" }, ctx);
		await emit("input", { type: "input", text: "/goal status", source: "interactive" }, ctx);
		assert.deepEqual(lastState().userGuidance, ["focus on tests first"]);
		await goal(ctx, "note prefer sqlite over redis");
		assert.deepEqual(lastState().userGuidance, ["focus on tests first", "prefer sqlite over redis"]);
	});

	await run(ctx, { text: "Reviewed README." });
	tick(1);
	await t.test("stall 1 → PROGRESS CHECK with the first lens", () => {
		assert.equal(lastState().stalledIterations, 1);
		assert.match(lastSent(), /PROGRESS CHECK: the last iteration changed no files/);
		assert.match(lastSent(), /mandatory lens is TESTS/);
		assert.match(lastSent(), /User guidance .*"focus on tests first" · "prefer sqlite over redis"/);
		assert.match(lastSent(), /✓ queue persistence · ✓ worker leasing/);
	});

	await run(ctx, { text: "Reviewed README again." });
	tick(1);
	await t.test("stall 2 → the lens rotates", () => {
		assert.equal(lastState().stalledIterations, 2);
		assert.match(lastSent(), /the last 2 iterations changed no files/);
		assert.match(lastSent(), /mandatory lens is CORRECTNESS/);
		assert.match(ctx.ui.widgets.autopilot[0], /stalled ×2/);
	});

	await run(ctx, { files: ["a.ts"], text: "Fixed." });
	tick(1);
	await t.test("a file change resets the stall counter", () => {
		assert.equal(lastState().stalledIterations, 0);
		assert.doesNotMatch(lastSent(), /PROGRESS CHECK/);
	});

	await t.test("an aborted run (Esc) pauses autopilot and injects nothing", async () => {
		const before = sent.length;
		await run(ctx, { text: "", stopReason: "aborted" });
		tick(1);
		assert.equal(lastState().phase, "paused");
		assert.equal(lastState().event, "interrupted");
		assert.equal(sent.length, before);
		assert.match(lastNotice(ctx), /paused after interrupt/);
		assert.match(ctx.ui.statuses.autopilot, /PAUSED/);
	});

	await t.test("runs while paused are not counted and do not continue", async () => {
		const before = sent.length;
		await run(ctx, { files: ["ignored.ts"], text: "user chat while paused" });
		tick(1);
		assert.equal(lastState().iteration, 5);
		assert.equal(sent.length, before);
	});

	await t.test("/goal resume continues", async () => {
		const before = sent.length;
		await goal(ctx, "resume");
		assert.equal(lastState().phase, "running");
		tick(1);
		assert.equal(sent.length, before + 1);
		assert.match(lastSent(), /^AUTOPILOT ITERATION 6/);
	});

	await t.test("errors back off exponentially and never stop the loop", async () => {
		let before = sent.length;
		await run(ctx, { text: "", stopReason: "error", errorMessage: "429 rate limited" });
		assert.equal(lastState().phase, "running");
		assert.equal(lastState().consecutiveErrors, 1);
		assert.match(lastNotice(ctx), /Retrying in 10s \(attempt 1\)/);
		tick(9_999);
		assert.equal(sent.length, before, "nothing before the 10s backoff elapses");
		tick(1);
		assert.equal(sent.length, before + 1);

		before = sent.length;
		await run(ctx, { text: "", stopReason: "error", errorMessage: "500" });
		assert.equal(lastState().consecutiveErrors, 2);
		tick(19_999);
		assert.equal(sent.length, before, "second error waits 20s");
		tick(1);
		assert.equal(sent.length, before + 1);
		assert.match(lastSent(), /NOTE: the previous 2 iterations ended with an error \(500\)/);

		await run(ctx, { files: ["b.ts"], text: "ok" });
		assert.equal(lastState().consecutiveErrors, 0);
		tick(1);
	});

	await t.test("liveness: no agent_start after a send → notify and re-send with backoff", () => {
		const before = sent.length;
		tick(60_000);
		assert.match(lastNotice(ctx), /could not start iteration/);
		assert.equal(sent.length, before);
		tick(10_000);
		assert.equal(sent.length, before + 1);
	});
	// The re-sent continuation armed a fresh liveness timer; a real run clears it.
	await run(ctx, { files: ["c0.ts"], text: "ok" });
	tick(1);

	await t.test("≥ 75 % context → compaction with autopilot instructions before the next iteration", async () => {
		ctx.usage = { tokens: 160_000, contextWindow: 200_000, percent: 80 };
		const before = sent.length;
		await run(ctx, { files: ["c.ts"], text: "big" });
		assert.equal(ctx.compactCalls.length, 1);
		assert.match(ctx.compactCalls[0].customInstructions, /AUTOPILOT objective/);
		tick(1);
		assert.equal(sent.length, before, "no continuation while compacting");
		ctx.compactCalls[0].onComplete({});
		assert.equal(lastState().compactions, 1);
		tick(1);
		assert.equal(sent.length, before + 1);
		ctx.usage = undefined;
	});

	await t.test("/goal stop aborts the in-flight run, clears timers, hides the UI", async () => {
		ctx.idle = false;
		await goal(ctx, "stop");
		assert.equal(ctx.aborted, 1);
		assert.equal(lastState().phase, "stopped");
		assert.equal(ctx.ui.statuses.autopilot, undefined);
		assert.equal(ctx.ui.widgets.autopilot, undefined);
		const before = sent.length;
		ctx.idle = true;
		await emit("agent_settled", { type: "agent_settled" }, ctx);
		tick(600_000);
		assert.equal(sent.length, before, "nothing injected after stop");
	});

	await t.test("'/goal stop the bleeding …' is an objective, not the stop subcommand", async () => {
		const before = sent.length;
		await goal(ctx, "stop the bleeding in the payment service");
		assert.equal(sent.length, before + 1);
		assert.match(lastSent(), /stop the bleeding in the payment service/);
		assert.equal(lastState().phase, "running");
		assert.equal(lastState().iteration, 0);
	});

	await t.test("startup/resume restores a RUNNING goal as PAUSED", async () => {
		const c2 = makeCtx();
		await emit("session_start", { type: "session_start", reason: "resume" }, c2);
		assert.equal(lastState().phase, "paused");
		assert.equal(lastState().event, "restored");
		assert.match(lastNotice(c2), /restored PAUSED/);
		assert.match(c2.ui.statuses.autopilot, /PAUSED/);
		const before = sent.length;
		tick(600_000);
		assert.equal(sent.length, before, "no auto-run on launch");
		await goal(c2, "resume");
		tick(1);
	});

	await t.test("/reload keeps a RUNNING goal running", async () => {
		const c3 = makeCtx();
		const before = sent.length;
		await emit("session_start", { type: "session_start", reason: "reload" }, c3);
		assert.equal(lastState().phase, "running");
		tick(749);
		assert.equal(sent.length, before);
		tick(1);
		assert.equal(sent.length, before + 1);
	});

	await t.test("a new session with no entries is inactive", async () => {
		const c4 = makeCtx({ sessionManager: { getBranch: () => [] } });
		await emit("session_start", { type: "session_start", reason: "new" }, c4);
		assert.equal(c4.ui.statuses.autopilot, undefined);
	});

	await t.test("AUTOPILOT.md and state.json mirror the state", () => {
		const md = readFileSync(join(CWD, ".pi/autopilot/AUTOPILOT.md"), "utf8");
		assert.match(md, /^# AUTOPILOT/);
		assert.match(md, /## Objective/);
		const js = JSON.parse(readFileSync(join(CWD, ".pi/autopilot/state.json"), "utf8"));
		assert.equal(js.version, 1);
	});

	await t.test("entry renderer shows lifecycle entries and hides bookkeeping ones", () => {
		const r = renderers.get("autopilot-state");
		const start = entries.find((e) => e.data.event === "start");
		const progress = entries.find((e) => e.data.event === "progress");
		assert.ok(r(start, { expanded: false }, theme));
		assert.equal(r(progress, { expanded: false }, theme), undefined);
	});

	rmSync(CWD, { recursive: true, force: true });
});
