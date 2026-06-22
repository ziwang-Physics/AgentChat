# Gemini Web Extended Thinking

## Trigger

Use this skill when the user asks to:
- Discuss a complex topic with Gemini Web (especially research, code review, architecture design)
- Run a prompt through Gemini Pro Extended Thinking mode
- Send content to `gemini.google.com` for deep reasoning

Do NOT use for: simple Q&A, quick lookups, or when the user hasn't explicitly asked for Gemini Web.

## Prerequisites (verify before execution)

```bash
# 1. Chrome debug must be running on port 9222
pgrep -f "chrome.*9222" || bash ~/start-chrome-debug.sh

# 2. Playwright must be installed
[ -d /tmp/node_modules/playwright ] || (cd /tmp && npm install playwright)

# 3. A Gemini tab must be open (excluding RotateCookies)
bash ~/connect-gemini.sh
```

## Invocation

```bash
node /home/wangzi/my-claude-skills/skills/gemini-web-extended-thinking/index.js "PROMPT"
```

Or pipe from stdin for long/multi-line prompts:

```bash
cat <<'EOF' | node /home/wangzi/my-claude-skills/skills/gemini-web-extended-thinking/index.js
Your prompt here...
EOF
```

The script returns Gemini's reply on stdout. All diagnostic messages go to stderr (prefixed with `[gemini]`).

## Execution Guarantee

The script enforces Pro Extended Thinking (延長思考) before EVERY submission:
- Detects current model from the selector button text
- Switches to Pro model if Flash/Flash-Lite is active
- Expands "思考程度" and selects "延長" / "Extended"
- Verifies the button shows "Pro延長" or "Pro Extended"
- Refuses to submit if the mode switch fails (exit code 2)

No manual pre-check needed — the script validates and retries internally.

## Error Recovery

| Exit code | Meaning | Action |
|-----------|---------|--------|
| 1 | Chrome debug not running or no Gemini tab | Run `~/start-chrome-debug.sh` then `~/connect-gemini.sh` |
| 2 | Pro Extended mode failed to activate (`ERR_MODEL_DEGRADED`) | **Stop execution.** Report to user that Gemini degraded. Do NOT retry blindly. |
| 3 | Gemini safety filter rejected the prompt (`ERR_SAFETY_REJECTED`) | Report the rejection to user. Do NOT retry — it won't help. |
| 4 | Response timeout, empty, or unknown error | Check if Gemini tab is still alive; reload and retry once. |

## Code Location

The Playwright/CDP implementation lives in `index.js` (same directory as this SKILL.md). Key functions:

- `ensureProExtended(page)` — model-switching state machine with retry loop
- `submitToGemini(page, message)` — full pipeline: type → send → wait → return
- `waitForResponse(page)` — polls `.model-response-text` until stable

DOM selectors and UI interaction details are documented as code comments in `index.js` — do not duplicate them here.
