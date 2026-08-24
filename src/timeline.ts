/**
 * Append-only timeline. Written exclusively by the extension — the model has no
 * tool that mutates it, so it serves as ground truth that survives context
 * compaction, in the spirit of Schema's Timeline.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface TimelineEntry {
	ts: string;
	kind: "input" | "tool" | "believe" | "backtest" | "plan" | "surprise" | "session";
	[key: string]: unknown;
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

export function appendTimeline(dir: string, entry: Omit<TimelineEntry, "ts">): void {
	const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
	fs.mkdirSync(dir, { recursive: true });
	fs.appendFileSync(path.join(dir, "timeline.jsonl"), line + "\n");
}
