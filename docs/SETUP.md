# Shared Chrome Setup Guide

> Referenced by: `gemini-web-extended-thinking/SKILL.md`, `five-agent-gemini-cli/SKILL.md`

## Quick Start

```bash
cp .env.example .env        # Edit proxy settings
bash scripts/setup.sh        # Verify environment
bash scripts/start-chrome-debug.sh  # Launch Chrome + Gemini
bash scripts/connect-gemini.sh      # Verify connection
```

## Chrome Flags (Minimum Required Set)

```
--disable-features=OptimizationHints,Translate,HttpsUpgrades
--disable-background-networking
--disable-client-side-phishing-detection
--disable-field-trial-config
--disable-component-update
--disable-sync
--ozone-platform=headless
--use-angle=swiftshader-webgl
--ignore-certificate-errors
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Gemini tab `about:blank` | 3-layer fail-safe | Restart daemon: `pkill -9 chrome && bash scripts/start-chrome-debug.sh` |
| `ERR_BLOCKED_BY_CLIENT` | Safe Browsing fail-safe | Check flags include `--disable-features=OptimizationHints` |
| SSL `net_error -100` | GFW RST or Reality TLS conflict | Use HTTP/SOCKS5 proxy, NOT VLESS Reality |
