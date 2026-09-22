#!/usr/bin/env bash
# PreToolUse(Write|Edit): when code being written contains a semantic decision,
# surface the code-vs-frontier-vs-System-One test and the branch it implies.
#
# Advisory only - never blocks. Tune TRIGGERS below; that is the whole job.
# Disable with: /hooks, or delete the entry from .claude/settings.json
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
# These are NAME heuristics and they are wrong in both directions - see the
# README section "The hook is itself a band-one heuristic". Tighten before
# loosening: a hook that fires on everything gets disabled inside a day.
B_CHOICE='(function|def|const|let|var|async def)[[:space:]]+[a-zA-Z_]*(classif|categoriz|route|detect|triage)'
B_SCORE='(function|def|const|let|var|async def)[[:space:]]+[a-zA-Z_]*(score|rank|relevan)'

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

# Log every firing so this hook's own precision is measurable. The README
# measures Jev across 2,400 calls; measuring the instrument is the same duty.
log="${CLAUDE_PROJECT_DIR:-.}/.claude/typesafe-check.log"
{ mkdir -p "$(dirname "$log")" 2>/dev/null &&
  printf '%s\t%s\ta=%s\tchoice=%s\tscore=%s\t%s\n' \
    "$(date -u +%FT%TZ)" "$mode" "${a:-0}" "${c:-0}" "${s:-0}" "$path" >> "$log"; } 2>/dev/null || true

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

jq -n --arg path "$(basename "$path")" --arg hit "$hit" --arg prim "$primitive" '{
  systemMessage: ("TypeSafe check: \($path) adds \($hit)."),
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: (
      "You are writing \($hit) in \($path). Apply the three-way test:\n" +
      "1. A regex, DNS lookup or DB query can answer it -> write the code. Do not call a model.\n" +
      "2. It needs multi-step reasoning, domain knowledge or generated prose -> frontier model.\n" +
      "3. A sensible person answers it in under a second from text you can show them -> the " +
      "System One band, where TypeSafe/Jev sits.\n" +
      (if $prim != "" then
        "If band 3, this reads as \($prim). " else
        "If band 3: " end) +
      "The confidence value is the whole point - code that ignores it gains nothing from a " +
      "calibrated model. Gate on it per consequence, not with one global number: above ~0.9 act, " +
      "0.5 to 0.9 confirm or flag for review, below 0.5 do not act - route to a human. Send " +
      "several questions against one shared `state` in a single request rather than looping.\n" +
      "State the verdict in one line, then proceed."
    )
  }
}'
