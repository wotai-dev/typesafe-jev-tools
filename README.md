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

Only these extensions: `.ts` `.tsx` `.mts` `.js` `.mjs` `.py`. Everything else exits immediately,
which is what keeps it usable in a repo full of Markdown.

Two trigger classes, both at the top of the script:

```bash
A='anthropic|@anthropic-ai|openai|messages\.create|chat\.completions|generateText'
B='(function|def|const|let|async def)[[:space:]]+[a-zA-Z_]*(classif|categoriz|score|rank|route|detect|triage|relevan)'
```

**Tune these. That is the whole job.** `B` is the looser of the two, so tighten it first if the
hook gets noisy. A hook that fires on everything gets disabled inside a day, which costs you more
than never installing it.

## The bug worth knowing about

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

If you write your own `Write|Edit` hook that inspects content, you probably have this bug.

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

TypeSafe has not published pricing. `/pricing` and `/limits` both 404 as of 2026-09-18, so the
"40 to 1,000x cheaper" claim is not currently checkable. Measured speed was 1.4x to 3.7x depending
on the comparison, against a claimed 20 to 200x.

DeepSeek, GLM and Kimi ran through OpenRouter. GPT-5 cost cells are empty because I have no rate
card I can cite for them, and an empty cell beats a guess.

Full writeup: [wotai.co](https://wotai.co)

## License

MIT
