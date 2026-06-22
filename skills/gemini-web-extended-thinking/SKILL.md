# Gemini Web Extended Thinking

## Trigger

Use this skill when the user asks to:
- Discuss a complex topic with Gemini Web (research, code review, architecture)
- Run a prompt through Gemini Pro Extended Thinking mode
- Send content to `gemini.google.com` for deep reasoning

Do NOT use for: simple Q&A, quick lookups, or when the user hasn't explicitly asked for Gemini Web.

## Prerequisites (verify before execution)

```bash
# 1. Chrome debug must be running on port 9222
pgrep -f "chrome.*9222" || bash ~/start-chrome-debug.sh

# 2. playwright-core must be installed (NOT the full playwright — saves ~300MB)
[ -d /tmp/node_modules/playwright-core ] || (cd /tmp && npm install playwright-core)

# 3. Ensure user is logged into Gemini in Chrome
bash ~/connect-gemini.sh
```

## Invocation

```bash
node index.js "PROMPT"
node index.js --timeout=300000 "PROMPT"
echo "Long prompt" | node index.js
node index.js --smoke      # verify environment without submitting
node index.js --doctor     # check Chrome CDP connectivity only
```

- `--timeout=N` — absolute execution deadline in ms (covers mode switch + typing + thinking + extraction). Default 600000 (10 min).
- `--smoke` — verify environment is healthy without sending a prompt. Exit 0 if OK.
- `--doctor` — check CDP port connectivity only. Does not require a Gemini tab.
- Response on stdout, diagnostics + elapsed timer spinner on stderr (`[gemini]` prefix).
- Telemetry written to `gemini-telemetry.jsonl` (JSON Lines format).

## Execution Guarantees (v2)

1. **Isolated tabs** — `acquireIsolatedPage` spawns a dedicated tab per invocation → parallel-safe.
2. **Action Toolbar detection** — `waitForResponse` anchors on Copy/Thumbs buttons appearing (only when generation AND rendering are complete).
3. **15s stability fallback** — `Date.now()`-bound innerText check if toolbar doesn't appear.
4. **Tiered recovery** — soft (stop generation + clear editor) → hard (page reload). Target crashes propagated, not swallowed.
5. **CDP reconnect** — `connectWithRetry` with `disconnected` event listener.
6. **Adaptive input** — `insertText` (≤50KB) / clipboard paste (>50KB) with payload integrity verification.
7. **Rate-limit detection** — checks `contenteditable` state before typing; exits code 5 if editor is locked.
8. **Session expiry watch** — verifies page URL hasn't redirected mid-generation.

## Error Recovery

| Exit | Error code | Meaning | Action |
|------|-----------|---------|--------|
| 1 | `ERR_NOT_AUTHENTICATED` | Gemini requires sign-in | Open gemini.google.com in Chrome and log in |
| 1 | — | Chrome CDP not reachable | Run `~/start-chrome-debug.sh` |
| 2 | `ERR_MODEL_DEGRADED` | Pro Extended failed to activate | **Stop.** Do NOT retry. Report to user. |
| 3 | `ERR_SAFETY_REJECTED` | Safety filter rejected prompt | Skip prompt. Do NOT retry. |
| 4 | `ERR_EDITOR_NOT_FOUND` | Input editor not in DOM (UI changed?) | Update selectors in index.js |
| 4 | `ERR_INPUT_CORRUPTED` | WebSocket dropped input frames | Retry (handled internally) |
| 5 | `ERR_RATE_LIMITED` | Editor locked — quota exceeded | Orchestrator should `sleep 3600` before retrying |
| 6 | `ERR_SESSION_EXPIRED` | Google auth expired mid-generation | Re-authenticate in Chrome, then retry |
| 7 | `ERR_TARGET_CRASHED` | Chrome tab crashed (OOM?) | Restart Chrome, increase resource limits |
| 10 | `ERR_TIMEOUT` | Max timeout reached — response incomplete | Partial output discarded; retry or increase `--timeout` |

## Key Architecture Decisions

- **Action Toolbar as completion anchor** — avoids false truncation when Extended Thinking pauses >6s mid-reasoning.
- **Tab isolation over page reuse** — prevents concurrent runs from corrupting each other's input.
- **Escape-to-dismiss** — more reliable than `body.click()` for Angular CDK overlays.
- **Partial state handling** — `ensureProExtended` checks if Extended is already visible before toggling accordion.
- **playwright-core** — ~3MB vs ~300MB for full `playwright`. No bundled browser binaries needed (CDP only).

## Code Location

- `index.js` — Playwright/CDP implementation (~550 lines, commented DOM selectors)
- `SKILL.md` — this file (AI-facing operational guide)
- `package.json` — npm package manifest with `playwright-core` dependency
