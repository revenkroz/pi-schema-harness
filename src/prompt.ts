/**
 * System-prompt snippet and status rendering.
 *
 * METHODOLOGY is a constant string so appending it to the system prompt does
 * not bust the provider prompt cache between turns. Dynamic state (warnings,
 * ledger status) is delivered as a separate message only when present.
 */

import type { Ledger, Plan, SchemaSession } from "./state.ts";
import { backtestFresh, countBeliefs } from "./state.ts";

export const METHODOLOGY = `
## Schema harness (active)

You are working under a Schema-style discipline: act like a physicist, not a gambler.
Your model of this system is a ledger of falsifiable beliefs, not vibes in context.

The loop:
1. THEORIZE — record what you believe about the system with schema_believe.
   Every belief that matters must have a cheap, deterministic shell check
   (exit 0 = holds; optionally an expected stdout substring).
2. CERTIFY — run schema_backtest to test ALL beliefs against reality before
   planning. A refuted belief is a finding, not a failure: revise it.
3. PLAN — commit a plan with schema_plan. Each step names a concrete action,
   a predicted observable outcome, and the belief ids it relies on. Plans built
   on unverified beliefs are gambling.
4. COMMIT & WATCH — execute the plan step by step, marking steps with
   schema_step_done. Compare every real outcome against the step's prediction.
5. SURPRISE RULE — the moment reality contradicts a prediction, STOP executing.
   Call schema_surprise with expected vs observed. The plan is void. Revise
   beliefs, re-run the backtest, commit a new plan. Reality outranks the model.

Persistent memory (survives context compaction — re-read these instead of guessing):
- .pi/schema/<task>/beliefs.json — the belief ledger
- .pi/schema/<task>/plan.json — the committed plan
- .pi/schema/<task>/timeline.jsonl — append-only record of everything that actually happened (you cannot edit it)
- .pi/schema/<task>/notes.md — your working notes; keep hypotheses and dead ends there

Act to discover: when two hypotheses both fit the evidence, prefer the cheapest
command that distinguishes them over more speculation.
`;

export function renderStatus(session: SchemaSession, ledger: Ledger, plan: Plan | null): string {
	const counts = countBeliefs(ledger);
	const lines: string[] = [];
	lines.push(`Schema harness: ${session.active ? "ACTIVE" : "off"} — task "${session.task}" (.pi/schema/${session.slug}/)`);
	lines.push(
		`Beliefs: ${ledger.beliefs.length} total — ${counts.verified} verified, ${counts.untested} untested, ${counts.refuted} refuted. Backtest: ${
			ledger.lastBacktestAt ? `${ledger.lastBacktestAt}${backtestFresh(ledger) ? " (fresh)" : " (STALE)"}` : "never run"
		}.`,
	);
	for (const b of ledger.beliefs) {
		lines.push(`  ${b.id} [${b.status}] ${b.statement}${b.check ? "" : " (no check!)"}`);
	}
	if (!plan) {
		lines.push("Plan: none committed.");
	} else if (plan.voided) {
		lines.push(`Plan: VOIDED at ${plan.voided.at} — ${plan.voided.reason}`);
	} else {
		const done = plan.steps.filter((s) => s.status === "done").length;
		lines.push(`Plan: "${plan.goal}" — ${done}/${plan.steps.length} steps done, ${plan.certifiedAt ? `certified ${plan.certifiedAt}` : "NOT certified"}.`);
		plan.steps.forEach((s, i) => {
			const mark = s.status === "done" ? "x" : s.status === "surprised" ? "!" : " ";
			lines.push(`  ${i + 1}. [${mark}] ${s.action} → predict: ${s.prediction}${s.beliefs.length ? ` (${s.beliefs.join(",")})` : ""}`);
		});
	}
	return lines.join("\n");
}

export function renderWarnings(warnings: string[]): string {
	return `⚠ Schema harness warnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`;
}
