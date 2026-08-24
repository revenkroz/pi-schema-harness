---
name: schema-dev
description: Schema-style discipline for non-trivial dev tasks — debugging unfamiliar systems, changes with unclear blast radius, or any task where your model of the system is unreliable. Turns implicit assumptions into falsifiable beliefs with executable checks, certifies them against reality before planning, and voids the plan on any misprediction. Use with the schema_* tools from pi-schema-harness.
---

# Schema for development

This skill adapts the Schema harness (schema-harness.github.io, ~99% on ARC-AGI-3
vs 42.83% for the same models on a generic harness) to software tasks. The
difference was never the model — it was the process: beliefs made explicit and
executable, verified against recorded reality before acting, and abandoned the
moment reality disagrees.

## When to use

Use this discipline when the system's behavior is not fully known to you:
debugging, working in an unfamiliar codebase, changes whose blast radius is
unclear, performance mysteries, flaky tests. Do NOT use it for trivial
mechanical edits — the overhead is not worth it there.

If the harness is not yet active, ask the user to run `/schema <task>`, or just
start calling the tools — the first call activates it.

## The loop

### 1. Theorize — beliefs, not vibes

Every assumption you are about to act on goes into the ledger via
`schema_believe`. A good belief is:

- **Falsifiable** — a statement that could be wrong: "the retry logic in
  `client.go` is never exercised by the failing test", not "the code looks fine".
- **Checkable** — carries a cheap, deterministic shell command whose exit code 0
  (optionally plus an `expect` stdout substring) confirms it:
  - "`parse_config` is the only caller of `load_yaml`" →
    `check: "test $(grep -rn 'load_yaml(' src --include='*.py' | grep -v parse_config | wc -l) -eq 0"`
  - "the failing test fails deterministically" →
    `check: "! go test ./pkg/x -run TestFlaky -count=3"`
  - "the bug reproduces on main" → a minimal repro script.
- **Load-bearing** — you only ledger what the plan will rely on.

A belief without a check cannot be certified. Either find a check or treat the
claim as a note in `notes.md`, not a belief.

### 2. Certify — backtest before you plan

Run `schema_backtest` before committing any plan. It replays every check
against the current state of the repo. A refuted belief is a *finding*: revise
the belief (or discover you were tracking the wrong thing entirely). Never plan
on top of a refuted or untested load-bearing belief — that is gambling, and the
squared cost shows up later as rework.

### 3. Plan — every step carries a prediction

Commit with `schema_plan`. Each step has:

- a concrete **action** ("add nil-check in `handler.go:42`, run `go test ./...`"),
- a **prediction** of the observable outcome ("TestNilPayload passes; no other
  test changes status"),
- the **belief ids** it relies on.

The plan is certified only when all referenced beliefs are verified and the
backtest is fresh. An uncertified plan is a smell: go back to step 1 or 2.

### 4. Execute and watch — the surprise rule

Execute step by step. After each step compare reality with the prediction:

- Match → `schema_step_done`.
- Mismatch → **stop immediately** and call `schema_surprise` with expected vs
  observed, naming the suspect belief ids. The plan is now void — do not
  "push through" the remaining steps. The counterexample can indict a single
  belief *or the representation itself* (you may be modeling the wrong
  entities). Revise, re-backtest, re-plan.

Reality outranks the model, always.

### 5. Act to discover

When two hypotheses both fit the evidence, do not speculate further — find the
cheapest command for which they predict *different* outcomes, run it, and let
reality decide. One discriminating experiment beats ten paragraphs of reasoning.

## Persistent memory

Everything lives in `.pi/schema/<task>/` and survives context compaction:

- `beliefs.json` — the ledger (read it instead of re-deriving your model)
- `plan.json` — the committed plan and its certification state
- `timeline.jsonl` — append-only record of real interactions, written by the
  extension; you cannot edit it, which is the point
- `notes.md` — yours: hypotheses, dead ends, open questions. Write it as if the
  next reader lost all context — they will (it will be you, post-compaction).

After compaction or on resume: re-read `beliefs.json` and `plan.json` first,
then continue the loop where the files say you are — not where you feel you are.
