#!/usr/bin/env bash
# PreToolUse(Write|Edit): when code being written contains a semantic decision,
# surface the code-vs-frontier-vs-System-One test and the branch it implies.
#
# Two stages. The regexes are the CHEAP GATE - they are name heuristics and they
# are wrong in both directions. When a key is available, Jev is the JUDGE on the
# rows the gate flags: it names the band with a confidence, and on the gate's
# false positives it shortens the advisory to one line. It never silences it.
# This is the repo's own argument applied to itself - classifying the decision is
# a band-3 question (a person answers it in under a second from code you can show
# them), so a regex alone cannot do it, and the regex is the cheap gate in front.
#
# Advisory only - never blocks, and never fails closed. No key, no curl, a
# timeout, a non-200, or unparseable JSON all fall back to the gate-only text.
# The judge is opt-in: TYPESAFE_CHECK_JUDGE=1 plus a key. Disable the hook: /hooks.
set -uo pipefail

payload=$(cat)

path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // ""')
case "$path" in
  *.ts|*.tsx|*.cts|*.mts|*.js|*.jsx|*.cjs|*.mjs|*.py) ;;
  *) exit 0 ;;
esac

# What this call is writing RIGHT NOW: Write's content, Edit's new_string, or a
# multi-edit's joined new_strings.
new=$(printf '%s' "$payload" | jq -r '
  .tool_input.content
  // .tool_input.new_string
  // ((.tool_input.edits // []) | map(.new_string // "") | join("\n"))
  // ""')

# Class A: an LLM call that may be overqualified for the judgment it makes.
A='anthropic|@anthropic-ai|openai|messages\.create|chat\.completions|responses\.create|generateText'
# Class B, split so the advice can name the right primitive instead of guessing.
# Widened once the judge existed, because recall was the judge's blind spot: Jev
# only ever sees what the gate flags, so `assessSentiment` and `pickHandler` were
# invisible no matter how good the judge got. A false positive now costs one line
# instead of eight - but it also costs one API call, so this is not a licence to
# match everything. Deliberately still OUT as too generic to be decision-shaped:
# evaluate, match, resolve, select, check, validate, parse, infer (TypeScript type
# inference is mechanical), similar (cosine math). Tighten before loosening either
# way - a hook that fires on everything gets disabled inside a day.
#
# Each fragment leads with [Xx] rather than the class being case-insensitive, so
# camelCase compounds match (`parseIntent`, `getSentiment`) while SCREAMING_CASE
# constants do not: `const SCORE_MAX = 10` is mechanical and a `grep -i` would
# have flagged it.
B_CHOICE='(function|def|const|let|var|async def)[[:space:]]+[a-zA-Z_]*([Cc]lassif|[Cc]ategoriz|[Rr]oute|[Dd]etect|[Tt]riage|[Ll]abel|[Bb]ucket|[Dd]isambiguat|[Ii]ntent|[Ss]entiment|[Pp]ick|[Jj]udg)'
B_SCORE='(function|def|const|let|var|async def)[[:space:]]+[a-zA-Z_]*([Ss]core|[Rr]ank|[Rr]elevan|[Aa]ssess|[Gg]rade|[Ss]ever|[Pp]riorit|[Tt]oxic|[Qq]ualit)'

# Two questions, not one: is the decision being AUTHORED here, or does it merely
# already exist in this file? An Edit's new_string is only the replacement text,
# so a two-line change inside an existing classifier carries no trigger word -
# the original version of this hook fired on everything EXCEPT the case it
# existed for. Scanning the file on disk fixes that, but collapsing the two
# signals into one is why it then nagged on every unrelated edit to any file
# that happened to contain `openai`. Keep them apart and say different things.
#
# Herestrings for the payload, never `printf | grep -q`: under `set -o pipefail`
# grep -q exits on the first match while printf still has the rest to write, so
# printf takes SIGPIPE, the pipeline returns 141, and the `&&` never fires - the
# match is found and the answer thrown away. Threshold is the 64KB pipe buffer.
#
# The file is grepped DIRECTLY, not read into a variable. An earlier version did
# `head -c 200000` into `$content`, which (a) silently missed any trigger past
# byte 200000 and (b) was no faster: measured 0.038s vs 0.037s on a 2MB file
# that the capped version reported clean. grep -q streams and exits early.
a_new=""; c_new=""; s_new=""
a_old=""; c_old=""; s_old=""
grep -qiE "$A"        <<< "$new" && a_new=1
grep -qE  "$B_CHOICE" <<< "$new" && c_new=1
grep -qE  "$B_SCORE"  <<< "$new" && s_new=1
if [ -f "$path" ]; then
  grep -qiE "$A"        "$path" && a_old=1
  grep -qE  "$B_CHOICE" "$path" && c_old=1
  grep -qE  "$B_SCORE"  "$path" && s_old=1
fi

[ -z "$a_new$c_new$s_new$a_old$c_old$s_old" ] && exit 0

# Authoring beats pre-existing: if any trigger is in the payload you are writing
# the decision now, which is the only moment the full test can change anything.
if [ -n "$a_new$c_new$s_new" ]; then
  mode="author"; a=$a_new; c=$c_new; s=$s_new
else
  mode="preexisting"; a=$a_old; c=$c_old; s=$s_old
fi

hit=""
[ -n "$a" ] && hit="an LLM call"
[ -n "$c$s" ] && hit="${hit:+$hit and }a hand-written classifier"

# The primitive follows from WHICH name matched. Only class B implies one - a
# bare LLM call says nothing about the shape of the answer wanted.
primitive=""
if [ -n "$c" ] && [ -n "$s" ]; then
  primitive="Choice (a typed option) or Score (a graded level), depending on which decision"
elif [ -n "$c" ]; then
  primitive="Choice, which returns \`choice\` plus \`probabilities\` and a 0-1 \`confidence\`"
elif [ -n "$s" ]; then
  primitive="Score, which returns \`score\` plus \`probabilities\` and a 0-1 \`confidence\`"
fi

# Fire once per file per mode per session. Nothing in the original design stopped
# it repeating the identical sentence fifty times about one file, and that is what
# gets a hook uninstalled. Keyed on session so a new session gets a fresh say.
sid=$(printf '%s' "$payload" | jq -r '.session_id // ""')
mark_dir="${TMPDIR:-/tmp}/typesafe-check/${sid:-$PPID}"
mark="$mark_dir/$(printf '%s|%s' "$path" "$mode" | cksum | tr -d ' ')"
[ -f "$mark" ] && exit 0
mkdir -p "$mark_dir" 2>/dev/null && : > "$mark" 2>/dev/null || true

# ---------------------------------------------------------------------------
# The judge. Only on `author` (pre-existing already gets one line, so there is
# nothing a verdict would change), only after dedupe, so at most one call per
# file per session. Everything here is best-effort: any failure leaves
# judge="off" and the gate-only text below is what ships.
#
# PRIVACY: this sends the code being authored to api.typesafe.ai, so it is off
# unless you say otherwise - TYPESAFE_CHECK_JUDGE=1, explicitly, plus a key. An
# earlier version enabled itself whenever a key happened to be resolvable, which
# is the wrong default for a file people install with curl: a key present for some
# other reason should not quietly start shipping their source anywhere.
# See the README section "Letting Jev judge".
# ---------------------------------------------------------------------------
judge="off"; jband=""; jconf=""; jsem=""; jmech=""
if [ "$mode" = "author" ] && [ "${TYPESAFE_CHECK_JUDGE:-0}" = "1" ] && command -v curl >/dev/null 2>&1; then
  key="${TYPESAFE_API_KEY:-}"
  if [ -z "$key" ]; then
    for f in "${CLAUDE_PROJECT_DIR:-.}/.claude/typesafe-check.env" "${CLAUDE_PROJECT_DIR:-.}/.env.local"; do
      [ -r "$f" ] || continue
      key=$(sed -n 's/^[[:space:]]*TYPESAFE_API_KEY[[:space:]]*=[[:space:]]*//p' "$f" | tr -d '"'\''' | head -1)
      [ -n "$key" ] && break
    done
  fi
  if [ -n "$key" ]; then
    # Both Nouls ask about the function's PURPOSE, not about what the code does.
    # The hook fires while code is being authored, which is when it is mostly
    # signatures and stubs, and Jev's documented literal reading answers the
    # question you wrote: "does this code decide ..." against a body that throws
    # is honestly answered No. Measured on a sentiment classifier - stub 0.10 vs
    # implementation 0.95 on the old wording, 0.97 vs 0.98 on this one. The
    # `mechanical` Noul stays low on a stub either way (0.38), which is correct:
    # nothing there is determinable yet, and since the one-line collapse requires
    # mechanical > 0.65, an unjudgeable stub gets the full advisory. Fails safe.
    #
    # Jev's documented jaggedness also includes context bloat: "accuracy falls as the
    # state grows with content unrelated to the decision. Unrelated detail acts as
    # a distractor." So send the matched REGION, not a blind prefix - the lines the
    # gate hit plus a little context, capped. Falls back to the head if extraction
    # yields nothing.
    snip=$(grep -nE "$A|$B_CHOICE|$B_SCORE" <<< "$new" 2>/dev/null | cut -d: -f1 | head -8 |
      while IFS= read -r n; do
        sed -n "$(( n>3 ? n-3 : 1 )),$(( n+8 ))p" <<< "$new"
      done | head -c 1500)
    [ -z "${snip//[[:space:]]/}" ] && snip=$(printf '%s' "$new" | head -c 1500)
    req=$(jq -n --arg state "$snip" '{
      state: $state, model: "jev-latest",
      questions: {
        semantic: { type: "noul", instructions:
          "This is source code. Is the purpose of this function to judge what some text means, such as its sentiment, intent, category, or relevance?" },
        mechanical: { type: "noul", instructions:
          "This is source code. Is the purpose of this function something arithmetic, field presence, string equality, a regular expression, or a lookup can fully determine?" },
        band: { type: "choice", instructions:
          "This is source code that makes a decision. Which approach fits that decision best?",
          criteria: {
            plain_code: "A regular expression, string comparison, arithmetic, field check, or a database lookup produces the same answer.",
            system_one: "A person reading the text would answer in under a second, and the answer is a typed judgment about that text.",
            frontier_model: "The answer requires multi-step reasoning, specialist domain knowledge, or written prose." } }
      }}')
    resp=$(curl -sS --max-time 4 -X POST https://api.typesafe.ai/v1/systemone \
             -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
             -d "$req" 2>/dev/null) || resp=""
    if [ -n "$resp" ]; then
      jband=$(jq -r '.answers.band.choice      // empty' <<< "$resp" 2>/dev/null)
      jconf=$(jq -r '.answers.band.confidence  // empty' <<< "$resp" 2>/dev/null)
      jsem=$( jq -r '.answers.semantic.noul    // empty' <<< "$resp" 2>/dev/null)
      jmech=$(jq -r '.answers.mechanical.noul  // empty' <<< "$resp" 2>/dev/null)
      [ -n "$jband" ] && [ -n "$jconf" ] && judge="on"
    fi
    unset key req resp
  fi
fi

# The gate matched a NAME; the judge says this code decides nothing about meaning
# and is fully determined mechanically. That is the gate's documented false
# positive (`scoreLead = l.email ? 10 : 0` measures semantic=0.08, plain_code at
# 0.99). The advisory is DOWNGRADED to one line - it is never suppressed.
#
# Suppression was the original design and it is wrong. Jev's jaggedness page says
# it "does not treat data as hostile by default. Content written to adversarially
# steer the model can move the answer", and the state here is the code being
# written. If a model verdict could silence this hook, a comment could too - and a
# hook that goes quiet because something in the input said so is the precise
# silent-failure class this repo exists to warn about. One short line cannot be
# weaponised into a hidden warning, and it is still ~8 lines less noise.
brief=""
if [ "$judge" = "on" ] && [ "$jband" = "plain_code" ]; then
  awk -v s="${jsem:-1}" -v m="${jmech:-0}" -v k="$jconf" \
      'BEGIN{exit !(s<0.35 && m>0.65 && k>=0.70)}' && brief=1
fi

log="${CLAUDE_PROJECT_DIR:-.}/.claude/typesafe-check.log"
{ mkdir -p "$(dirname "$log")" 2>/dev/null &&
  printf '%s\t%s\ta=%s\tchoice=%s\tscore=%s\tjudge=%s\tband=%s\tconf=%s\tsem=%s\tmech=%s\t%s\t%s\n' \
    "$(date -u +%FT%TZ)" "$mode" "${a:-0}" "${c:-0}" "${s:-0}" "$judge" \
    "${jband:--}" "${jconf:--}" "${jsem:--}" "${jmech:--}" \
    "${brief:+brief}${brief:-full}" "$path" >> "$log"; } 2>/dev/null || true

# The one-line form: the gate was wrong, say so and get out of the way.
if [ -n "$brief" ]; then
  jq -n --arg path "$(basename "$path")" --arg conf "$jconf" '{
    systemMessage: ("TypeSafe check: \($path) - Jev says plain code (\($conf))."),
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: (
      "A name in \($path) looked like a semantic decision, but Jev judged it plain code at " +
      "confidence \($conf): the result is mechanically determined. No model needed. Carry on."
    ) } }'
  exit 0
fi

if [ "$mode" = "preexisting" ]; then
  jq -n --arg path "$(basename "$path")" --arg hit "$hit" '{
    systemMessage: ("TypeSafe check: \($path) already contains \($hit)."),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: (
        "\($path) already contains \($hit); this edit does not add one. Nothing to do " +
        "unless you are changing the decision itself - if you are, apply the three-way test " +
        "(plain code / frontier model / System One). Do not restructure working code on this " +
        "hint alone."
      )
    }
  }'
  exit 0
fi

jq -n --arg path "$(basename "$path")" --arg hit "$hit" --arg prim "$primitive" \
      --arg judge "$judge" --arg band "$jband" --arg conf "$jconf" --arg sem "$jsem" '
  ($conf | tonumber? // 0) as $k |
  {
    systemMessage: (
      if $judge == "on" then "TypeSafe check: \($path) - Jev says \($band) (confidence \($conf))."
      else "TypeSafe check: \($path) adds \($hit)." end),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: (
        (if $judge == "on" and $k >= 0.7 then
          "Jev judged the decision in \($path): **\($band)**, confidence \($conf) " +
          "(semantic \($sem)). " +
          (if $band == "plain_code" then
            "Write the code. A regex, comparison, or lookup answers this - do not call a model."
           elif $band == "frontier_model" then
            "This needs multi-step reasoning, domain knowledge or generated prose. A System One " +
            "model is the wrong tool; use a frontier model."
           else
            "This is the System One band. " +
            (if $prim != "" then "It reads as \($prim). " else "" end) +
            "The confidence value is the whole point - code that ignores it gains nothing from a " +
            "calibrated model. Gate on it per consequence, not with one global number: above ~0.9 " +
            "act, 0.5 to 0.9 confirm or flag for review, below 0.5 do not act - route to a human. " +
            "Send several questions against one shared `state` in a single request rather than " +
            "looping." end) +
          "\nState the verdict in one line, then proceed."
        else
          (if $judge == "on" then
            "Jev was unsure here (\($band) at only \($conf)), so decide it yourself. " else "" end) +
          "You are writing \($hit) in \($path). Apply the three-way test:\n" +
          "1. A regex, DNS lookup or DB query can answer it -> write the code. Do not call a model.\n" +
          "2. It needs multi-step reasoning, domain knowledge or generated prose -> frontier model.\n" +
          "3. A sensible person answers it in under a second from text you can show them -> the " +
          "System One band, where TypeSafe/Jev sits.\n" +
          (if $prim != "" then "If band 3, this reads as \($prim). " else "If band 3: " end) +
          "The confidence value is the whole point - code that ignores it gains nothing from a " +
          "calibrated model. Gate on it per consequence: above ~0.9 act, 0.5 to 0.9 confirm or " +
          "flag, below 0.5 route to a human. Send several questions against one shared `state` in " +
          "one request rather than looping.\n" +
          "State the verdict in one line, then proceed." end)
      )
    }
  }'
