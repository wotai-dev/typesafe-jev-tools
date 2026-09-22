# typesafe-jev-tools

A Claude Code hook that asks whether the decision you are writing needs a model at all.

It fires when you write code containing an LLM call or a hand-written classifier, and injects a
three-way test into the agent's context. It never blocks, and it recommends plain code at least as
often as it recommends a model.

## The three-way test

1. **A regex, a DNS lookup or a database query can answer it.** Write the code. Do not call a model.
2. **It needs multi-step reasoning, domain knowledge or generated prose.** Frontier model.
3. **A sensible person answers it in under a second from text you can show them.** That is the
   System One band, where [Jev](https://typesafe.ai) lives.

Band three is larger than it first looks. "Is this angry." "Does this paragraph support that
claim." "Which of these six handlers does this request want." Each of those usually gets either a
brittle heuristic or an overqualified LLM call.

The trap the hook exists to prevent is band one. A judgment model measured against labels that a
regex could produce gives you a confident, meaningless number.

## Install

Copy the hook into your project and point Claude Code at it.

```bash
mkdir -p .claude/hooks
curl -sL https://raw.githubusercontent.com/wotai-dev/typesafe-jev-tools/main/hooks/typesafe-check.sh \
  -o .claude/hooks/typesafe-check.sh
chmod +x .claude/hooks/typesafe-check.sh
```

Then merge `settings.example.json` into `.claude/settings.json`. If you already have a
`PreToolUse` block, add the hook to its `hooks` array rather than replacing it.

Verify it is wired up:

```bash
jq -e '.hooks.PreToolUse[] | select(.matcher == "Write|Edit") | .hooks[].command' .claude/settings.json
```

Exit 0 and a printed command means it is registered. Claude Code only watches directories that
had a settings file when the session started, so if the hook does not fire, open `/hooks` once or
restart the session.

## What trips it

Only these extensions: `.ts` `.tsx` `.cts` `.mts` `.js` `.jsx` `.cjs` `.mjs` `.py`. Everything else
exits immediately, which is what keeps it usable in a repo full of Markdown.

Three trigger classes, all at the top of the script:

```bash
A='anthropic|@anthropic-ai|openai|messages\.create|chat\.completions|responses\.create|generateText'
B_CHOICE='(function|def|const|let|var|async def)[[:space:]]+[a-zA-Z_]*(classif|categoriz|route|detect|triage)'
B_SCORE='(function|def|const|let|var|async def)[[:space:]]+[a-zA-Z_]*(score|rank|relevan)'
```

`B` is split in two so the advice can name the right primitive — a `classify*`/`route*`/`triage*`
name reads as a **Choice** (a typed option), a `score*`/`rank*`/`relevance*` name as a **Score** (a
graded level). Both return `probabilities` and a 0-1 `confidence`; the hook quotes the thresholds
rather than the product, because code that ignores the confidence value gains nothing from a
calibrated model.

**Tune these. That is the whole job.** The `B` classes are looser than `A`, so tighten those first
if the hook gets noisy. A hook that fires on everything gets disabled inside a day, which costs you
more than never installing it.

### It fires on authoring, not on reading

The two signals are kept apart. A trigger in the tool payload means you are **writing** the decision
right now — the only moment the three-way test can change anything — and gets the full test. A
trigger found *only* in the file on disk means the decision already existed and this edit did not
add it; that gets one line and no lecture. Collapsing the two is why an earlier version nagged on
every unrelated edit to any file that happened to contain `openai` anywhere.

It also fires **once per file, per mode, per session**. Nothing in the original design stopped it
repeating the identical paragraph fifty times about one file, and that, not inaccuracy, is what gets
a hook uninstalled.

Every firing appends a line to `.claude/typesafe-check.log` — timestamp, mode, which classes hit,
path. The point is that this hook's own precision should be measurable. Measuring Jev across 2,400
calls and the instrument not at all would be the same mistake band one warns about.

### The hook is itself a band-one heuristic

Worth saying plainly, because the three-way test convicts it. `B_CHOICE` and `B_SCORE` match
**identifiers**. They cannot tell `scoreLead = (l) => l.email ? 10 : 0` — arithmetic on a field —
from a genuine semantic judgment, and they miss `assessSentiment`, `gradeAnswer`, `pickHandler`,
`bucketize`. It is a name-based heuristic detecting name-based heuristics, measured against no
labels: exactly the band-one device the first rule tells you not to build.

That is a deliberate trade, not an oversight. The alternative — asking a model whether the code you
are about to write contains a semantic decision — is a model call on every keystroke to decide
whether you should make a model call. The regex is wrong in both directions, cheap, and legible
enough to tune in one line, and the log now makes its error rate something you can count instead of
argue about. If it fires on your `scoreLead` and the answer is arithmetic, that is the tool working
as designed and costing you one sentence.

## Letting Jev judge

The section above convicts the regexes: they match names, so they cannot tell
`scoreLead = (l) => l.email ? 10 : 0` from a real judgment. The fix is the thing this hook spends
its whole output recommending. **Classifying the decision is itself a band-three question** — a
person shown the code answers in under a second — so the regex is the cheap gate and Jev is the
judge on the rows it flags.

**This is off unless a key is found.** With no key the hook behaves exactly as documented above and
nothing leaves your machine.

### Turning it on

```bash
# any one of these; checked in this order
export TYPESAFE_API_KEY=...                      # environment
echo 'TYPESAFE_API_KEY=...' > .claude/typesafe-check.env
echo 'TYPESAFE_API_KEY=...' >> .env.local        # gitignore it

TYPESAFE_CHECK_JUDGE=0   # disable the judge, keep the gate
```

Needs `curl` in addition to `bash`, `jq` and `grep`. If `curl` is missing, the key is absent, the
request times out (4s), the API returns non-200, or the JSON will not parse, the hook falls back to
the gate-only advisory. Measured with a deliberately invalid key: 0.46s, no hang, correct fallback.

> **It sends code to a third party.** When the judge is on, the matched region of the code you are
> writing is POSTed to `api.typesafe.ai`. That is a real change from the hermetic version — decide
> deliberately, and do not enable it in a repo whose source you cannot send anywhere.

### What it does with the answer

One request, three questions against one `state` (the [Speculative Fan-Out][fanout] pattern — extra
questions are evaluated in parallel, so they ride along free): a `band` **Choice** over
`plain_code` / `system_one` / `frontier_model`, plus two **Noul** probabilities, `semantic` ("does
this code decide what some text means") and `mechanical` ("is the result fully determined by
arithmetic, a field check, a regex or a lookup").

[fanout]: https://docs.typesafe.ai/patterns

Measured on five shapes:

| code | `semantic` | `mechanical` | band | conf |
|---|---|---|---|---|
| `scoreLead = l.email ? 10 : 0` | 0.08 | high | `plain_code` | 0.97 |
| `classifyTone(msg)` | 0.93 | low | `system_one` | 0.71 |
| `planMigration(schema, constraints)` | 0.48 | low | `frontier_model` | 0.96 |
| `detectUrl` (a regex test) | 0.17 | high | `plain_code` | 1.00 |
| `relevanceOf(query, doc)` | 0.84 | low | `system_one` | **0.37** |

Which becomes:

- **Confident verdict** (≥0.7) — the advisory states the band and the confidence instead of making
  you walk the test. `frontier_model` says plainly that a System One model is the wrong tool.
- **Gate false positive** — `plain_code`, `semantic` < 0.35, `mechanical` > 0.65, confidence ≥ 0.7
  collapses eight lines to one: *a name looked like a decision, Jev judged it plain code, carry on.*
- **Low confidence** — the last row. The hook says "Jev was unsure here (system_one at only 0.37),
  so decide it yourself" and falls back to the full test. That row is the best argument for the
  design: a tool that asserted `system_one` at 0.37 would be worse than the regex, and the whole
  premise of this repo is that knowing when not to trust the answer is the product.

Cost is bounded by construction: the judge runs only in authoring mode, only after the
once-per-file-per-session gate, on a ~1500-character snippet. About 500 input tokens per firing,
which at $0.042/Mtok with free output is roughly **$0.00002** a time.

### Three things Jev's own jaggedness page changed

[`/model-jaggedness/jev-1.13`](https://docs.typesafe.ai/model-jaggedness/jev-1.13) is short, and
reading it after building the first version rewrote three decisions. Worth copying the habit: read
the model's stated weaknesses before trusting it in a loop.

- *"Accuracy falls as the state grows with content unrelated to the decision. Unrelated detail acts
  as a distractor."* The first version sent `head -c 4000` of the payload. It now sends the matched
  region — the lines the gate hit plus a little context. A blind prefix is a distractor generator.
- *"Scoping words, negations, and implied conditions are read at face value"*, and double negatives
  or indirection answer less reliably. The first version asked one contrastive question ("about
  meaning **as opposed to** mechanical") and used criteria like "No model is needed". Both are now
  positive and single-barreled, and the contrast became two independent Nouls.
- *"Does not treat data as hostile by default. Content written to adversarially steer the model can
  move the answer."* The first version let a confident `plain_code` **suppress** the advisory. The
  `state` is the code being written, so a comment could have silenced the hook — the exact silent
  failure this file spends three sections warning about. Suppression is gone; the shortest the hook
  ever gets is one line.

Every firing logs its verdict to `.claude/typesafe-check.log` — `judge`, `band`, `conf`, `sem`,
`mech`, and whether the output was `full` or `brief` — so the judge's own agreement rate with the
gate is something you can count after a week.

## Three bugs worth knowing about

All three passed every piped test and did nothing useful against a real file. If you write your own
`Write|Edit` hook that inspects content, you probably have at least one of them.

### 1. Reading only the replacement text

The first version only read `tool_input.new_string`. It passed every piped test and then did
nothing useful.

On an `Edit`, `new_string` is only the replacement text. Changing two lines inside an existing
classifier produces a payload that never contains the word `classify`, so the hook fired on every
edit and stayed silent on precisely the case it existed for. Only triggering a real edit against a
real file surfaced it.

The fix is to also scan the file on disk, which exists pre-edit:

```bash
if [ -f "$path" ]; then
  content="$content
$(head -c 200000 "$path" 2>/dev/null)"
fi
```

### 2. A whitespace check that blows the timeout

Emptiness was tested with `[ -z "${content//[[:space:]]/}" ]`. Bash pattern substitution with a
character class is super-linear over a long string, and the hook feeds it up to 200KB:

| Content | Time |
|---|---|
| 500 B | 0.03s |
| 2 KB | 0.56s |
| 4 KB | 3.55s |
| 8 KB | >25s |

`settings.example.json` sets `timeout: 10` and the registered command ends in `|| true`, so on any
ordinary source file the hook burned its whole budget and then had the kill swallowed. No output, no
error, ~10s added to every write. Measured 12.02s on a 340KB file; 0.09s after the fix.

```bash
case "$content" in *[![:space:]]*) ;; *) exit 0 ;; esac
```

The check was redundant anyway — whitespace-only content matches neither class and exits two lines
later. It was only ever saving two forks.

### 3. `printf | grep -q` throwing the answer away

Both classes were tested as `printf '%s' "$content" | grep -qiE "$A" && hit=...`, under
`set -o pipefail`. `grep -q` exits on the first match while `printf` still has the rest of the file
to write, so `printf` takes SIGPIPE, the **pipeline returns 141**, and `&&` never fires. The match is
found and discarded. The threshold is the 64KB pipe buffer:

```text
 64000 bytes -> status=0   hit=[SET]
 96000 bytes -> status=141 hit=[EMPTY]
```

Fix is a herestring, which is a file rather than a pipe, so no reader closes early:

```bash
grep -qiE "$A" <<< "$content" && hit="an LLM call"
```

This one was **masked** by bug 2 — the script timed out before reaching the greps — so fixing the
timeout alone trades a dead hook for a lying one. They have to be fixed together.

## Why a hook and not a line in AGENTS.md

A document works when something reads it. A hook fires whether or not the skill loaded, whether or
not the agent was paying attention, and whether or not anyone remembered the rule existed. The
failure mode being prevented here is silent: you write a brittle heuristic, nothing objects, and
it ships.

## What the measurements showed

Sixteen models, 150 identical passages, run 2026-09-18, zero errors across 2,400 calls. The task
returns a raw probability, which is the only honest way to measure calibration. ECE is expected
calibration error, the average gap between claimed and observed, weighted by bin size. Lower is
better. "Unsure" is the share of rows placed between 0.35 and 0.65.

| Model | Accuracy | ECE | Unsure | p50 | Distinct | Cost / 150 |
|---|---|---|---|---|---|---|
| z-ai/glm-5.3-flash | **74.0%** | 0.089 | 6.0% | 7,527ms | 28 | $0.026 |
| Claude Sonnet 5 | 71.3% | **0.062** | 41.3% | 1,674ms | 18 | $0.160 |
| Claude Fable 5.1 | 70.0% | 0.115 | 36.7% | 3,293ms | 19 | $0.806 |
| gpt-5.6-terra | 70.0% | 0.173 | 4.0% | 1,551ms | 34 | n/a |
| moonshotai/kimi-k2.5 | 70.0% | 0.199 | 0.7% | 12,268ms | 17 | $0.363 |
| deepseek/deepseek-v4-flash | 69.3% | 0.183 | 3.3% | 1,361ms | 15 | **$0.003** |
| gpt-5.4-mini | 67.3% | 0.192 | 6.7% | 934ms | 47 | n/a |
| gpt-5.6-luna | 66.7% | 0.243 | 1.3% | 1,186ms | 29 | n/a |
| Claude Haiku 4.5 | 66.0% | 0.122 | 2.7% | 631ms | 11 | $0.064 |
| **Jev** | 66.0% | 0.121 | **34.7%** | **455ms** | **56** | n/a |
| deepseek/deepseek-v4-pro | 65.3% | 0.262 | 0.7% | 11,156ms | 23 | $0.277 |
| gpt-5.5 | 65.3% | 0.190 | 11.3% | 1,136ms | 39 | n/a |
| z-ai/glm-5.3 | 64.7% | 0.225 | 6.0% | 4,082ms | 28 | $0.268 |
| gpt-5.6-sol | 64.7% | 0.235 | 7.3% | 2,452ms | 33 | n/a |
| Claude Opus 5 (effort low) | 64.7% | 0.163 | 23.3% | 2,090ms | 33 | $0.400 |
| moonshotai/kimi-k3 | 58.0% | 0.309 | 1.3% | 5,677ms | 30 | $0.731 |

Open-weight models ran through OpenRouter, so their latency includes a routing hop.

**Only four of the sixteen will say they are unsure.** Sonnet 5 at 41.3%, Fable 5.1 at 36.7%, Jev
at 34.7%, Opus 5 at 23.3%. Everything else sits at 7.3% or below, and that drop does not care about
price or vintage: every GPT-5 variant is at 11.3% or less, every open-weight model at 6.0% or less,
and `kimi-k2.5` and `deepseek-v4-pro` both land on 0.7%, which is one row in 150.

**Jev is the only one of those four that answers in under a second.** The next fastest is Sonnet 5
at 3.7x the latency.

Sonnet 5 is the best calibrated model here, at roughly half Jev's error. A gate that runs on 100%
of traffic cannot usually afford 1,674ms, so the comparison that decides anything is inside the
sub-second budget:

| Model | p50 | ECE | Unsure | Distinct values |
|---|---|---|---|---|
| **Jev** | **455ms** | **0.121** | **34.7%** | **56** |
| Claude Haiku 4.5 | 631ms | 0.122 | 2.7% | 11 |
| gpt-5.4-mini | 934ms | 0.192 | 6.7% | 47 |

Jev is the fastest model in the whole field, the best calibrated of the three fast ones, and flags
uncertainty 5x more often than the next-best. That last column is what an escalation rule runs on:
route uncertain rows to a human or a bigger model and the rule fires on 34.7% of Jev's rows and
2.7% of Haiku's. The ambiguous rows have not gone anywhere; Haiku answers them confidently and
sends them through.

If your code does not branch on the confidence value, none of this matters and you should use what
you already have. That is why the hook asks the question instead of answering it.

Two more tasks, Jev against Haiku only:

| Task | Rows | Jev | Haiku | Jev p50 | Haiku p50 |
|---|---|---|---|---|---|
| business category | 149 | 79.9% | **83.2%** | 432ms | 702ms |
| commit type | 100 | **50.0%** | 42.0% | 468ms | 695ms |

Accuracy splits. Latency does not.

TypeSafe has published pricing since this was first written. It is on the docs site, not the
marketing site: [`docs.typesafe.ai/models.md`](https://docs.typesafe.ai/models.md), verified
2026-09-21. One model, `jev-1.13.0`, at **$42 per billion input tokens** — $0.042 per million — and
**output tokens are free**. Limits on the same page: 250,000 tokens/second, 1,200 requests/minute,
64k context per request, 32k for `state` plus the longest question. `typesafe.ai/pricing`,
`typesafe.ai/models` and `/limits` all still 404, which is why the earlier note said there was none.

That makes the cheapness claim checkable, against Anthropic's published input rates:

| vs | Input $/Mtok | Jev is |
|---|---|---|
| Claude Fable 5.1 | $10.00 | 238.1x cheaper |
| Claude Opus 5 | $5.00 | 119.0x cheaper |
| Claude Sonnet 5 | $2.00 | 47.6x cheaper |
| Claude Haiku 4.5 | $1.00 | **23.8x cheaper** |

TypeSafe's own "238x lower input price than Claude Fable 5.1" reproduces exactly. The advertised
**"40 to 1,000x cheaper" range does not hold at its floor**: against Haiku 4.5 — the cheapest Claude,
and the only one Jev beats on latency in the sub-second table above — it is 23.8x, not 40x. Free
output widens the real gap on output-heavy work, but this task returns a single probability, so input
dominates and the input-only comparison is the honest one here.

Jev's `Cost / 150` cell above stays empty because the per-passage token counts came from a harness
that is not in this repo. The published rate does bound it: if every cent of Haiku's measured $0.064
were input at $1.00/Mtok, that is at most 64,000 input tokens, so at most **$0.0027** for the same
150 rows with output free — which would put Jev at roughly the same cost as `deepseek-v4-flash`, the
cheapest measured row. A bound is not a measurement, so it is not in the table.

Measured speed was 1.4x to 3.7x depending on the comparison. The homepage claims 193.6x faster and
244.6x cheaper on "System One tasks", illustrated with a workflow at $0.000081 in 0.114s against
$0.013880 in 8.566s — neither figure is reproduced by anything measured here.

DeepSeek, GLM and Kimi ran through OpenRouter. GPT-5 cost cells are empty because I have no rate
card I can cite for them, and an empty cell beats a guess.

Full writeup: [wotai.co](https://wotai.co)

## License

MIT
