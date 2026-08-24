/**
 * pi-schema-harness — a Schema-style harness for dev tasks.
 *
 * Adapts the Schema ARC-AGI-3 harness (schema-harness.github.io) to software
 * work: the world model becomes a ledger of falsifiable beliefs with executable
 * checks, certification becomes a backtest over those checks, plans carry
 * predictions per step, and any misprediction voids the plan (surprise rule).
 * An append-only timeline of real interactions is written by this extension
 * and cannot be edited by the model.
 *
 * Enforcement is soft: warnings are injected into context; nothing is blocked.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { METHODOLOGY, renderStatus, renderWarnings } from "./prompt.ts";
import type { SchemaSession } from "./state.ts";
import {
	computeWarnings,
	ENTRY_TYPE,
	ensureDir,
	loadLedger,
	loadPlan,
	schemaDir,
	slugify,
} from "./state.ts";
import { appendTimeline, truncate } from "./timeline.ts";
import { registerSchemaTools } from "./tools.ts";

export default function schemaHarness(pi: ExtensionAPI) {
	let session: SchemaSession | null = null;

	const activate = (ctx: ExtensionContext, task: string): SchemaSession => {
		session = { active: true, slug: slugify(task), task };
		const dir = schemaDir(ctx.cwd, session.slug);
		ensureDir(dir);
		pi.appendEntry<SchemaSession>(ENTRY_TYPE, session);
		appendTimeline(dir, { kind: "session", event: "activate", task });
		return session;
	};

	const deactivate = (ctx: ExtensionContext): void => {
		if (!session) return;
		appendTimeline(schemaDir(ctx.cwd, session.slug), { kind: "session", event: "deactivate" });
		session = { ...session, active: false };
		pi.appendEntry<SchemaSession>(ENTRY_TYPE, session);
		session = null;
	};

	registerSchemaTools(pi, {
		get: () => (session?.active ? session : null),
		activate,
	});

	pi.registerCommand("schema", {
		description: "Schema harness: /schema <task> to activate, /schema status, /schema off",
		getArgumentCompletions: (prefix) =>
			["status", "off"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "off") {
				deactivate(ctx);
				ctx.ui.notify("Schema harness deactivated", "info");
				return;
			}
			if (arg === "" || arg === "status") {
				if (!session?.active) {
					ctx.ui.notify("Schema harness is not active. Use /schema <task> to start.", "info");
					return;
				}
				const dir = schemaDir(ctx.cwd, session.slug);
				pi.sendMessage({
					customType: "schema-status",
					content: renderStatus(session, loadLedger(dir), loadPlan(dir)),
					display: true,
				});
				return;
			}
			const s = activate(ctx, arg);
			ctx.ui.notify(`Schema harness active — .pi/schema/${s.slug}/`, "info");
			pi.sendMessage(
				{
					customType: "schema-activated",
					content:
						`Schema harness activated for task: "${arg}".\n` +
						"Begin the loop: observe the system, then record your initial falsifiable beliefs with schema_believe " +
						"(each with a shell check), certify them with schema_backtest, and only then commit a plan with schema_plan.",
					display: true,
				},
				{ triggerTurn: true },
			);
		},
	});

	// Restore harness state on startup/resume/fork.
	pi.on("session_start", async (_event, ctx) => {
		// getBranch(): entries of the current branch only. getEntries() spans all
		// branches of the session tree, so it could restore state from an
		// abandoned branch after the user edits an earlier message.
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type?: string; customType?: string; data?: SchemaSession };
			if (e.type === "custom" && e.customType === ENTRY_TYPE) {
				if (e.data?.active) {
					session = e.data;
					ensureDir(schemaDir(ctx.cwd, e.data.slug));
				}
				break;
			}
		}
	});

	// Timeline: record user input.
	pi.on("input", async (event, ctx) => {
		if (!session?.active) return;
		appendTimeline(schemaDir(ctx.cwd, session.slug), {
			kind: "input",
			source: event.source,
			text: truncate(event.text, 1500),
		});
	});

	// Timeline: record every real tool interaction (schema_* tools log themselves semantically).
	pi.on("tool_result", async (event, ctx) => {
		if (!session?.active || event.toolName.startsWith("schema_")) return;
		const output = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		appendTimeline(schemaDir(ctx.cwd, session.slug), {
			kind: "tool",
			tool: event.toolName,
			input: truncate(JSON.stringify(event.input), 800),
			output: truncate(output, 2000),
			isError: event.isError,
		});
	});

	// Methodology into the system prompt (constant → cache-friendly); warnings as a message only when present.
	pi.on("before_agent_start", async (event, ctx) => {
		if (!session?.active) return;
		const dir = schemaDir(ctx.cwd, session.slug);
		const warnings = computeWarnings(loadLedger(dir), loadPlan(dir));
		return {
			systemPrompt: event.systemPrompt + METHODOLOGY,
			...(warnings.length > 0
				? { message: { customType: "schema-warning", content: renderWarnings(warnings), display: true } }
				: {}),
		};
	});
}
