#!/usr/bin/env bash
# PreToolUse(Write|Edit): when code being written contains a semantic decision,
# surface the Jev-vs-code-vs-frontier-model test.
#
# Advisory only - never blocks. Tune TRIGGERS below; that is the whole job.
# Disable with: /hooks, or delete the entry from .claude/settings.json
set -uo pipefail

payload=$(cat)

path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // ""')
case "$path" in
  *.ts|*.tsx|*.mts|*.js|*.mjs|*.py) ;;
  *) exit 0 ;;
esac

content=$(printf '%s' "$payload" | jq -r '
  .tool_input.content
  // .tool_input.new_string
  // ((.tool_input.edits // []) | map(.new_string // "") | join("\n"))
  // ""')
# An Edit's new_string is only the replacement text, so also scan the file on
# disk (it exists pre-edit). Without this, editing inside an existing
# classifier never trips the check.
if [ -f "$path" ]; then
  content="$content
$(head -c 200000 "$path" 2>/dev/null)"
fi
[ -z "${content//[[:space:]]/}" ] && exit 0

# Class A: an LLM call that may be overqualified for the judgment it makes.
A='anthropic|@anthropic-ai|openai|messages\.create|chat\.completions|generateText'
# Class B: a hand-written semantic classifier.
B='(function|def|const|let|async def)[[:space:]]+[a-zA-Z_]*(classif|categoriz|score|rank|route|detect|triage|relevan)'

hit=""
printf '%s' "$content" | grep -qiE "$A" && hit="an LLM call"
printf '%s' "$content" | grep -qE "$B"  && hit="${hit:+$hit and }a hand-written classifier"
[ -z "$hit" ] && exit 0

jq -n --arg path "$(basename "$path")" --arg hit "$hit" '{
  systemMessage: ("TypeSafe check: \($path) contains \($hit)."),
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: (
      "This file contains \($hit). Before continuing, apply the three-way test:\n" +
      "1. Can a regex, DNS lookup, or DB query answer it? -> plain code. Do not call a model.\n" +
      "2. Does it need multi-step reasoning, domain expertise, or generated prose? -> frontier model.\n" +
      "3. Would a sensible person answer it in under a second from text you can show them? -> TypeSafe/Jev.\n" +
      "Jev returns a typed answer plus a calibrated probability, batches N questions over one state, " +
      "and is the cheap gate in front of an expensive model - not a replacement for it. " +
      "State the verdict in one line, then proceed. Do not restructure working code on this hint alone."
    )
  }
}'
