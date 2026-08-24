# pi-schema-harness

A [pi](https://pi.dev) package that makes the agent test its assumptions before acting on them.

It is a port of [Schema](https://schema-harness.github.io/) — the harness that took frontier models from 42.83% to ~99% on the ARC-AGI-3 benchmark. Same models, different process. The trick: don't let the model keep its picture of the world in its head. Make it write that picture down, prove it against reality, and throw away any plan the moment reality disagrees.

## The idea

While working on a task, an agent piles up assumptions: "this function is only called from here", "this test fails because of X". Some of them are wrong, and the agent usually finds out late — after it has already edited files based on them.

With this package the agent instead:

1. **Writes assumptions down** as *beliefs*. Each belief carries a shell command that checks it — exit code 0 means it still holds.
2. **Checks them all** against the real repo before planning. This is the *backtest*. A failed check is a finding, not an annoyance: the belief gets fixed before it does damage.
3. **Plans with predictions.** Every plan step says what should observably happen if the beliefs are right. A plan is *certified* only when every belief it relies on has passed a fresh backtest.
4. **Stops on surprise.** If an outcome doesn't match the prediction, the plan is void. The agent must revise its beliefs, re-run the backtest, and plan again. Reality always wins.

On top of that, the extension logs every real tool call into an append-only file the model cannot edit. The log and the belief files live on disk, so they survive context compaction: after a long session the agent re-reads what it actually knew instead of guessing.

Nothing is ever blocked — the extension only warns when the agent is about to act on shaky ground (refuted beliefs, an uncertified or voided plan).

## Install

```bash
pi install git:github.com/revenkroz/pi-schema-harness
# or from a local checkout:
pi install /path/to/pi-schema-harness
```

Needs pi ≥ 0.84. Checks run through `/bin/sh`, so macOS or Linux.

## Use

```
/schema fix flaky TestOrderSync   # start working on a task
/schema status                    # show beliefs and plan
/schema off                       # stop
```

`/schema <task>` adds the methodology to the system prompt and starts logging. From there the agent drives itself with five tools:

| Tool | What it does |
|-|-|
| `schema_believe` | Record or revise a belief, with an optional check command; can verify it on the spot |
| `schema_backtest` | Re-run every check; refuted beliefs void any plan that relied on them |
| `schema_plan` | Commit a plan; certified only if all referenced beliefs are verified and the backtest is fresh |
| `schema_step_done` | Mark a step whose prediction came true |
| `schema_surprise` | Record a misprediction: voids the plan, marks suspect beliefs for re-checking |

There is also a `schema-dev` skill (`/skill:schema-dev`) with the full methodology — how to write good beliefs, what counts as a surprise, when not to bother.

## Files on disk

Everything lives under `.pi/schema/<task>/`:

```
beliefs.json    # the belief ledger — the agent's model of the system
plan.json       # the committed plan and whether it's certified
timeline.jsonl  # append-only log of what actually happened (extension-written only)
notes.md        # the agent's free-form working notes
```

The active task is also saved into the pi session, so resuming or forking a session restores the harness automatically.

## What doesn't carry over from Schema

In ARC-AGI-3 the world model is a program you can search inside, so planning is free. A codebase is not a closed simulator, so that part stays behind. What does carry over: explicit, checkable assumptions instead of vibes; verification before action; replanning on surprise; and memory that outlives the context window.
