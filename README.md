# Gemini Extended Thinking for Claude

Bridge [Claude Code](https://claude.ai/code) with [Gemini Web](https://gemini.google.com)'s Pro Extended Thinking mode — enabling deep, multi-step reasoning for complex research and engineering workflows.

## Prerequisites

### Chrome Debug Mode (for Gemini skills)

Skills interacting with `gemini.google.com` require Chrome running in debug mode on port 9222.

```bash
# One-time setup: install Playwright in a shared location
cd /tmp && npm install playwright

# Start Chrome in debug mode
./scripts/start-chrome-debug.sh

# Connect to Gemini (opens a tab with persistent login)
./scripts/connect-gemini.sh
```

Chrome profile is stored in `~/.chrome-debug-profile` — login state persists across restarts.

## Skills

| Skill | Description |
|-------|-------------|
| [gemini-web-extended-thinking](skills/gemini-web-extended-thinking/) | Interact with Gemini Web via Playwright/CDP, enabling Pro Extended Thinking mode for complex reasoning |

## Installation

```bash
# Clone the repo
git clone git@github.com:ziwang-Physics/gemini-extended-thinking.git

# Symlink the skill into Claude Code
mkdir -p ~/.claude/skills
ln -s $(pwd)/gemini-extended-thinking/skills/* ~/.claude/skills/
```

## License

MIT
