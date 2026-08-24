/**
 * The four-plus-one Schema tools: believe / backtest / plan / step_done / surprise.
 *
 * All enforcement is soft: tools warn and record, they never block. The
 * extension separately injects warnings into context when the ledger or plan
 * is in a state Schema would consider unsafe to act from.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Belief, Ledger, Plan, SchemaSession } from "./state.ts";
import {
	backtestFresh,
	countBeliefs,
	loadLedger,
	loadPlan,
	nextBeliefId,
	saveLedger,
	savePlan,
	schemaDir,
} from "./state.ts";
import { appendTimeline, truncate } from "./timeline.ts";

export interface HarnessHandle {
	get(): SchemaSession | null;
	/** Activate the harness (used by tools for self-activation when the model starts theorizing unprompted). */
	activate(ctx: ExtensionContext, task: string): SchemaSession;
}

const CHECK_TIMEOUT_MS = 60_000;
const MAX_EVIDENCE = 6;

function ledgerSummary(ledger: Ledger): string {
	const counts = countBeliefs(ledger);
	return `Ledger: ${ledger.beliefs.length} beliefs (${counts.verified} verified, ${counts.untested} untested, ${counts.refuted} refuted).`;
}

function pushEvidence(belief: Belief, note: string): void {
	belief.evidence.push(note);
	if (belief.evidence.length > MAX_EVIDENCE) belief.evidence.splice(0, belief.evidence.length - MAX_EVIDENCE);
}

const NOT_ACTIVE_ERROR =
	"Schema harness is not active. Ask the user to run /schema <task>, or start with schema_believe and pass the task parameter.";

export function registerSchemaTools(pi: ExtensionAPI, harness: HarnessHandle): void {
	// Only schema_believe with an explicit task may self-activate; the other tools
	// must not silently resurrect the harness (e.g. after /schema off) under a
	// generic slug and start a ledger disconnected from the real task's.
	const requireSession = (ctx: ExtensionContext, taskHint?: string): { session: SchemaSession; dir: string } | null => {
		let session = harness.get();
		if (!session && taskHint) session = harness.activate(ctx, taskHint);
		if (!session) return null;
		return { session, dir: schemaDir(ctx.cwd, session.slug) };
	};

	const notActive = () => ({
		content: [{ type: "text" as const, text: NOT_ACTIVE_ERROR }],
		details: {},
		isError: true,
	});

	const runCheck = async (
		belief: Belief,
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<{ holds: boolean; inconclusive: boolean; aborted: boolean; note: string }> => {
		const result = await pi.exec("/bin/sh", ["-c", belief.check ?? "true"], {
			cwd,
			timeout: CHECK_TIMEOUT_MS,
			signal,
		});
		if (result.killed) {
			// killed covers both timeout and user abort — they must not be conflated:
			// an abort says nothing about the belief and must not touch its status.
			if (signal?.aborted) {
				return { holds: false, inconclusive: true, aborted: true, note: "check aborted" };
			}
			return { holds: false, inconclusive: true, aborted: false, note: `check timed out after ${CHECK_TIMEOUT_MS / 1000}s` };
		}
		const missingExpect = belief.expect !== undefined && !result.stdout.includes(belief.expect);
		const holds = result.code === 0 && !missingExpect;
		const note = holds
			? `check passed (exit 0${belief.expect ? ", expected output present" : ""})`
			: missingExpect && result.code === 0
				? `exit 0 but stdout lacks expected substring "${truncate(belief.expect ?? "", 80)}"`
				: `exit ${result.code}: ${truncate((result.stderr || result.stdout).trim(), 200)}`;
		return { holds, inconclusive: false, aborted: false, note };
	};

	// ------------------------------------------------------------------ believe
	pi.registerTool({
		name: "schema_believe",
		label: "Schema: believe",
		description:
			"Record or revise a falsifiable belief about the system in the Schema ledger. " +
			"Give every load-bearing belief a cheap deterministic shell check (exit 0 = holds; " +
			"optionally an expected stdout substring). Beliefs start as 'untested' until a check passes.",
		promptSnippet: "Record a falsifiable belief about the system, optionally verifying it immediately",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Existing belief id to revise (e.g. B3). Omit to create a new one." })),
			statement: Type.String({ description: "Falsifiable statement about the system" }),
			check: Type.Optional(Type.String({ description: "Shell command that tests the statement; exit code 0 means it holds" })),
			expect: Type.Optional(Type.String({ description: "Substring that must appear in the check's stdout" })),
			verify: Type.Optional(Type.Boolean({ description: "Run the check immediately" })),
			evidence: Type.Optional(Type.String({ description: "Supporting observation (command output, timeline reference)" })),
			task: Type.Optional(Type.String({ description: "Task name; only used to initialize the harness if it is not active yet" })),
		}),
		// All schema tools do read-modify-write on shared files; pi runs sibling
		// tool calls in parallel by default, which would race on the ledger.
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const active = requireSession(ctx, params.task);
			if (!active) return notActive();
			const { dir } = active;
			const ledger = loadLedger(dir);
			const now = new Date().toISOString();

			let belief = params.id ? ledger.beliefs.find((b) => b.id === params.id) : undefined;
			if (params.id && !belief) {
				return { content: [{ type: "text", text: `No belief ${params.id} in the ledger. ${ledgerSummary(ledger)}` }], details: {}, isError: true };
			}
			if (!belief) {
				belief = { id: nextBeliefId(ledger), statement: params.statement, evidence: [], status: "untested", updatedAt: now };
				ledger.beliefs.push(belief);
			}
			belief.statement = params.statement;
			if (params.check !== undefined) belief.check = params.check;
			if (params.expect !== undefined) belief.expect = params.expect;
			belief.status = "untested";
			belief.updatedAt = now;
			if (params.evidence) pushEvidence(belief, params.evidence);

			let verifyNote = "";
			if (params.verify && belief.check) {
				const { holds, inconclusive, aborted, note } = await runCheck(belief, ctx.cwd, signal);
				if (!aborted) {
					belief.status = inconclusive ? "untested" : holds ? "verified" : "refuted";
					pushEvidence(belief, note);
				}
				verifyNote = ` Verification: ${note}${aborted ? "" : ` → ${belief.status}`}.`;
			}
			ledger.changedAt = now;
			saveLedger(dir, ledger);
			appendTimeline(dir, { kind: "believe", id: belief.id, statement: belief.statement, status: belief.status });

			return {
				content: [{ type: "text", text: `${belief.id} recorded (${belief.status}).${verifyNote} ${ledgerSummary(ledger)}${belief.check ? "" : " Note: this belief has no check — it cannot be certified by backtest."}` }],
				details: { id: belief.id, status: belief.status },
			};
		},
	});

	// ----------------------------------------------------------------- backtest
	pi.registerTool({
		name: "schema_backtest",
		label: "Schema: backtest",
		description:
			"Run every belief's check against the current state of the system and update the ledger. " +
			"This is Schema's certify step: do it before committing a plan and after any surprise. " +
			"Refuted beliefs must be revised, not ignored.",
		promptSnippet: "Re-verify all recorded beliefs against reality",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_id, _params, signal, onUpdate, ctx) {
			const active = requireSession(ctx);
			if (!active) return notActive();
			const { dir } = active;
			const ledger = loadLedger(dir);
			const now = new Date().toISOString();

			const verified: string[] = [];
			const refuted: string[] = [];
			const inconclusive: string[] = [];
			const unchecked: string[] = [];
			let wasAborted = false;

			for (const belief of ledger.beliefs) {
				if (!belief.check) {
					unchecked.push(belief.id);
					continue;
				}
				onUpdate?.({ content: [{ type: "text", text: `Checking ${belief.id}: ${belief.statement}` }], details: {} });
				const { holds, inconclusive: skip, aborted, note } = await runCheck(belief, ctx.cwd, signal);
				if (aborted) {
					// An abort says nothing about reality; leave this and all remaining
					// beliefs untouched instead of demoting them with false evidence.
					wasAborted = true;
					break;
				}
				belief.status = skip ? "untested" : holds ? "verified" : "refuted";
				belief.updatedAt = now;
				pushEvidence(belief, `backtest: ${note}`);
				(skip ? inconclusive : holds ? verified : refuted).push(`${belief.id}${holds ? "" : ` — ${note}`}`);
			}
			if (!wasAborted) ledger.lastBacktestAt = now;
			saveLedger(dir, ledger);

			// Certification side effects on the active plan.
			const plan = loadPlan(dir);
			let planNote = "";
			if (plan && !plan.voided && !wasAborted) {
				const refs = new Set(plan.steps.flatMap((s) => s.beliefs));
				const refutedRefs = ledger.beliefs.filter((b) => refs.has(b.id) && b.status === "refuted");
				const allVerified = refs.size > 0 && [...refs].every((id) => ledger.beliefs.find((b) => b.id === id)?.status === "verified");
				if (refutedRefs.length > 0) {
					plan.voided = { reason: `backtest refuted ${refutedRefs.map((b) => b.id).join(", ")}`, at: now };
					planNote = ` Active plan VOIDED: it relied on ${refutedRefs.map((b) => b.id).join(", ")}. Revise beliefs and commit a new plan.`;
				} else if (allVerified) {
					plan.certifiedAt = now;
					planNote = " Active plan re-certified.";
				} else if (plan.certifiedAt) {
					// Some referenced belief slid back to untested (or the plan cites
					// nothing verifiable) — a stale certification stamp would lie.
					delete plan.certifiedAt;
					planNote = " Active plan certification REVOKED: a referenced belief is no longer verified.";
				}
				savePlan(dir, plan);
			}

			appendTimeline(dir, { kind: "backtest", verified: verified.length, refuted: refuted.length, inconclusive: inconclusive.length, aborted: wasAborted });
			const report = [
				wasAborted ? "Backtest ABORTED — remaining beliefs left untouched, results below are partial." : "",
				`Backtest: ${verified.length} verified, ${refuted.length} refuted, ${inconclusive.length} inconclusive, ${unchecked.length} without checks.`,
				refuted.length ? `REFUTED:\n${refuted.map((r) => `  ${r}`).join("\n")}` : "",
				inconclusive.length ? `Inconclusive (timeout): ${inconclusive.join(", ")}` : "",
				unchecked.length ? `No check (cannot certify): ${unchecked.join(", ")}` : "",
			]
				.filter(Boolean)
				.join("\n");
			return { content: [{ type: "text", text: report + planNote }], details: { verified, refuted, inconclusive, unchecked, aborted: wasAborted } };
		},
	});

	// --------------------------------------------------------------------- plan
	pi.registerTool({
		name: "schema_plan",
		label: "Schema: plan",
		description:
			"Commit a plan: ordered steps, each with a concrete action, a predicted observable outcome, " +
			"and the belief ids it relies on. The plan is certified only if every referenced belief is " +
			"verified and the backtest is fresh. Committing replaces any previous plan.",
		promptSnippet: "Commit a plan whose steps carry predictions grounded in verified beliefs",
		parameters: Type.Object({
			goal: Type.String({ description: "What the plan achieves, phrased as an observable end state" }),
			steps: Type.Array(
				Type.Object({
					action: Type.String({ description: "Concrete action to take" }),
					prediction: Type.String({ description: "Observable outcome you predict for this action" }),
					beliefs: Type.Optional(Type.Array(Type.String(), { description: "Belief ids this step relies on" })),
				}),
				{ minItems: 1 },
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const active = requireSession(ctx);
			if (!active) return notActive();
			const { dir } = active;
			const ledger = loadLedger(dir);
			const now = new Date().toISOString();

			const plan: Plan = {
				goal: params.goal,
				steps: params.steps.map((s) => ({ action: s.action, prediction: s.prediction, beliefs: s.beliefs ?? [], status: "pending" })),
				createdAt: now,
			};

			const warnings: string[] = [];
			const refs = [...new Set(plan.steps.flatMap((s) => s.beliefs))];
			const missing = refs.filter((id) => !ledger.beliefs.some((b) => b.id === id));
			if (missing.length) warnings.push(`unknown belief ids: ${missing.join(", ")}`);
			const unverified = refs.filter((id) => ledger.beliefs.find((b) => b.id === id)?.status !== "verified");
			if (unverified.length) warnings.push(`unverified beliefs referenced: ${unverified.join(", ")}`);
			if (!backtestFresh(ledger)) warnings.push("backtest is stale (ledger changed since the last schema_backtest)");
			if (refs.length === 0) warnings.push("no step references any belief — this plan is not grounded in the model");

			if (warnings.length === 0) plan.certifiedAt = now;
			savePlan(dir, plan);
			appendTimeline(dir, { kind: "plan", goal: plan.goal, steps: plan.steps.length, certified: !!plan.certifiedAt });

			const text = plan.certifiedAt
				? `Plan committed and CERTIFIED (${plan.steps.length} steps). Execute step by step; after each step compare reality with the prediction. On any mismatch call schema_surprise immediately.`
				: `Plan committed but NOT certified:\n${warnings.map((w) => `- ${w}`).join("\n")}\nProceeding on an uncertified plan is gambling — verify the beliefs and re-commit.`;
			return { content: [{ type: "text", text }], details: { certified: !!plan.certifiedAt, warnings } };
		},
	});

	// ---------------------------------------------------------------- step_done
	pi.registerTool({
		name: "schema_step_done",
		label: "Schema: step done",
		description:
			"Mark a plan step as completed after its prediction was confirmed by reality. " +
			"If the outcome did NOT match the prediction, call schema_surprise instead.",
		promptSnippet: "Mark a plan step completed (prediction confirmed)",
		parameters: Type.Object({
			step: Type.Integer({ minimum: 1, description: "1-based index of the completed step" }),
			observed: Type.Optional(Type.String({ description: "What was actually observed (briefly)" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const active = requireSession(ctx);
			if (!active) return notActive();
			const { dir } = active;
			const plan = loadPlan(dir);
			if (!plan) return { content: [{ type: "text", text: "No committed plan. Use schema_plan first." }], details: {}, isError: true };
			if (plan.voided) return { content: [{ type: "text", text: `Plan is voided (${plan.voided.reason}) — commit a new one first.` }], details: {}, isError: true };
			const step = plan.steps[params.step - 1];
			if (!step) return { content: [{ type: "text", text: `Plan has only ${plan.steps.length} steps.` }], details: {}, isError: true };
			step.status = "done";
			savePlan(dir, plan);
			appendTimeline(dir, { kind: "plan", event: "step_done", step: params.step, observed: params.observed });
			const remaining = plan.steps.filter((s) => s.status === "pending").length;
			return {
				content: [{ type: "text", text: remaining === 0 ? "All plan steps done. Verify the goal state holds, then report." : `Step ${params.step} done. ${remaining} steps remaining.` }],
				details: { remaining },
			};
		},
	});

	// ----------------------------------------------------------------- surprise
	pi.registerTool({
		name: "schema_surprise",
		label: "Schema: surprise",
		description:
			"Record a prediction failure: reality contradicted the model. Voids the active plan. " +
			"Call this the moment an outcome differs from what you predicted — reality outranks the model. " +
			"Then revise the suspect beliefs, re-run schema_backtest, and commit a new plan.",
		promptSnippet: "Record a misprediction; voids the plan and forces model revision",
		parameters: Type.Object({
			expected: Type.String({ description: "What the model predicted" }),
			observed: Type.String({ description: "What actually happened" }),
			step: Type.Optional(Type.Integer({ minimum: 1, description: "1-based index of the plan step that failed" })),
			suspect_beliefs: Type.Optional(Type.Array(Type.String(), { description: "Belief ids now in doubt; they are demoted to 'untested'" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const active = requireSession(ctx);
			if (!active) return notActive();
			const { dir } = active;
			const now = new Date().toISOString();
			const plan = loadPlan(dir);
			if (plan && !plan.voided) {
				if (params.step && plan.steps[params.step - 1]) plan.steps[params.step - 1].status = "surprised";
				plan.voided = { reason: `expected "${truncate(params.expected, 120)}", observed "${truncate(params.observed, 120)}"`, at: now };
				savePlan(dir, plan);
			}
			const ledger = loadLedger(dir);
			const demoted: string[] = [];
			for (const id of params.suspect_beliefs ?? []) {
				const belief = ledger.beliefs.find((b) => b.id === id);
				if (belief) {
					belief.status = "untested";
					belief.updatedAt = now;
					pushEvidence(belief, `suspected after surprise: observed "${truncate(params.observed, 120)}"`);
					demoted.push(id);
				}
			}
			if (demoted.length) {
				ledger.changedAt = now;
				saveLedger(dir, ledger);
			}
			appendTimeline(dir, { kind: "surprise", expected: truncate(params.expected, 300), observed: truncate(params.observed, 300), step: params.step, demoted });

			return {
				content: [
					{
						type: "text",
						text:
							`Surprise recorded; the plan is void.${demoted.length ? ` Demoted to untested: ${demoted.join(", ")}.` : ""} ` +
							"The counterexample can indict a rule OR the representation itself — consider whether the belief is wrong or the wrong thing is being tracked. " +
							"Next: revise beliefs (schema_believe), certify (schema_backtest), then commit a new plan (schema_plan). Do not continue the old plan.",
					},
				],
				details: { demoted },
			};
		},
	});
}
