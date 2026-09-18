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

Run on 2026-09-18 against 149 rows of real business data, same set through both models.

| | Accuracy | p50 | p95 | Input tok/row | Output tok/row |
|---|---|---|---|---|---|
| Jev (`jev-1.13.0`) | 79.9% | 432ms | 620ms | 507 | 84 |
| Claude Haiku 4.5 | **83.2%** | 702ms | 1,244ms | 422 | 19 |

Haiku was more accurate. The two agreed on 143 of 149 rows. Jev was 1.6x faster, not the 20 to
200x on TypeSafe's landing page.

The separation was in the confidence value:

| Stated confidence | Jev n / accuracy | Haiku n / accuracy |
|---|---|---|
| 0.00–0.60 | 7 → 28.6% | 1 → 100% |
| 0.60–0.80 | 11 → 36.4% | 7 → 71.4% |
| 0.80–0.95 | 32 → 62.5% | 29 → **55.2%** |
| 0.95–1.00 | 99 → 93.9% | 112 → 91.1% |

Jev's accuracy climbs monotonically with its stated confidence. Haiku's inverts in the middle, so
a threshold placed there does the opposite of what you intended. Across 149 rows Haiku produced
**10 distinct confidence values** and put 0.95 on 98 of them; Jev produced **32**.

That is the whole reason to reach for a System One model, and the reason the hook asks the
question instead of answering it: if your code does not branch on the confidence, use whatever you
already have.

TypeSafe has not published pricing. `/pricing` and `/limits` both 404 as of 2026-09-18, so the
"40 to 1,000x cheaper" claim is not currently checkable.

Full writeup: [wotai.co](https://wotai.co)

## License

MIT
