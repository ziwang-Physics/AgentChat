# Let Your Agent Chat With Gemini

Collection of skills for [Claude Code](https://claude.ai/code) to automate complex workflows.

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
git clone git@github.com:HelloZi/my-claude-skills.git

# Symlink skills into Claude Code
mkdir -p ~/.claude/skills
ln -s $(pwd)/my-claude-skills/skills/* ~/.claude/skills/
```

## License

MIT
