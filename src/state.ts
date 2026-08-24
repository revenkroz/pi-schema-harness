/**
 * State model for the Schema harness.
 *
 * Files under `.pi/schema/<slug>/` are the source of truth:
 *   beliefs.json  — the belief ledger (the "world model")
 *   plan.json     — the committed plan
 *   timeline.jsonl — append-only interaction record (written only by the extension)
 *   notes.md      — free-form working notes (written by the model with normal tools)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type BeliefStatus = "untested" | "verified" | "refuted";

export interface Belief {
	id: string;
	statement: string;
	/** Shell command; exit code 0 means the statement holds. */
	check?: string;
	/** Optional substring that must appear in the check's stdout. */
	expect?: string;
	status: BeliefStatus;
	evidence: string[];
	updatedAt: string;
}

export interface Ledger {
	beliefs: Belief[];
	/** Bumped whenever a belief is added or changed; used to detect stale backtests/plans. */
	changedAt?: string;
	lastBacktestAt?: string;
}

export type PlanStepStatus = "pending" | "done" | "surprised";

export interface PlanStep {
	action: string;
	prediction: string;
	beliefs: string[];
	status: PlanStepStatus;
}

export interface Plan {
	goal: string;
	steps: PlanStep[];
	createdAt: string;
	/** Set when, at commit or backtest time, all referenced beliefs were verified and the backtest was fresh. */
	certifiedAt?: string;
	voided?: { reason: string; at: string };
}

/** Session-scoped harness state, persisted via appendEntry so it survives resume/fork. */
export interface SchemaSession {
	active: boolean;
	slug: string;
	task: string;
}

export const ENTRY_TYPE = "pi-schema-harness";

export function slugify(task: string): string {
	const full = task
		.toLowerCase()
		.replace(/[^a-z0-9а-яё]+/gi, "-")
		.replace(/^-+|-+$/g, "");
	if (full.length <= 48) return full || "task";
	// Truncated slugs get a hash suffix so long tasks sharing a prefix don't collide.
	let hash = 0;
	for (let i = 0; i < full.length; i++) hash = (hash * 31 + full.charCodeAt(i)) >>> 0;
	return `${full.slice(0, 42).replace(/-+$/, "")}-${hash.toString(36).slice(0, 5)}`;
}

export function schemaDir(cwd: string, slug: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "schema", slug);
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	const notes = path.join(dir, "notes.md");
	if (!fs.existsSync(notes)) fs.writeFileSync(notes, "# Notes\n");
}

function readJson<T>(file: string, fallback: T): T {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return fallback; // missing file: normal on first use
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		// Corrupt file: preserve it instead of letting the next save destroy the evidence.
		try {
			fs.copyFileSync(file, `${file}.corrupt`);
		} catch {}
		return fallback;
	}
}

function writeJsonAtomic(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, "\t") + "\n");
	fs.renameSync(tmp, file);
}

export function loadLedger(dir: string): Ledger {
	return readJson<Ledger>(path.join(dir, "beliefs.json"), { beliefs: [] });
}

export function saveLedger(dir: string, ledger: Ledger): void {
	writeJsonAtomic(path.join(dir, "beliefs.json"), ledger);
}

export function loadPlan(dir: string): Plan | null {
	return readJson<Plan | null>(path.join(dir, "plan.json"), null);
}

export function savePlan(dir: string, plan: Plan): void {
	writeJsonAtomic(path.join(dir, "plan.json"), plan);
}

export function countBeliefs(ledger: Ledger): Record<BeliefStatus, number> {
	const counts: Record<BeliefStatus, number> = { untested: 0, verified: 0, refuted: 0 };
	for (const b of ledger.beliefs) counts[b.status]++;
	return counts;
}

export function nextBeliefId(ledger: Ledger): string {
	let max = 0;
	for (const b of ledger.beliefs) {
		const m = /^B(\d+)$/.exec(b.id);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `B${max + 1}`;
}

/** A backtest is fresh when it ran after the last ledger change. */
export function backtestFresh(ledger: Ledger): boolean {
	if (!ledger.lastBacktestAt) return ledger.beliefs.every((b) => !b.check);
	if (!ledger.changedAt) return true;
	return ledger.lastBacktestAt >= ledger.changedAt;
}

/** Soft-enforcement warnings injected into context when non-empty. */
export function computeWarnings(ledger: Ledger, plan: Plan | null): string[] {
	const warnings: string[] = [];
	const refuted = ledger.beliefs.filter((b) => b.status === "refuted");
	if (refuted.length > 0) {
		warnings.push(
			`Refuted beliefs in the ledger: ${refuted.map((b) => b.id).join(", ")}. Revise them (schema_believe) before relying on the model.`,
		);
	}
	if (plan && !plan.voided) {
		if (!plan.certifiedAt) {
			warnings.push("The committed plan was never certified (some referenced beliefs were unverified or the backtest was stale).");
		} else if (ledger.changedAt && plan.certifiedAt < ledger.changedAt) {
			warnings.push("The belief ledger changed after the plan was certified. Re-run schema_backtest and re-commit the plan.");
		}
	}
	if (plan?.voided) {
		warnings.push(
			`The active plan was VOIDED (${plan.voided.reason}). Revise beliefs, run schema_backtest, then commit a new plan before further edits.`,
		);
	}
	return warnings;
}
