---
name: agentchat-media-studio
description: Use when an agent must submit image or video generation prompts to logged-in free web creation platforms, upload product references, fall back when a provider has no quota, and save generated media locally.
---

# AgentChat MediaStudio

Use the user's existing Chrome login state to generate and save images or videos through supported web platforms.

## Supported providers

- ChatGPT Web (`chatgpt`, image generation through AgentChat-OneWeb)
- 豆包 (`doubao`)
- 即梦 (`jimeng`)
- 小云雀 (`xiaoyunque`)

Default routing:

```text
image: ChatGPT Web → 豆包 → 即梦 → 小云雀
video: 即梦 → 小云雀 → 豆包
```

Daily points, quotas, models, and UI labels are not hard-coded as business facts. Detect quota and authentication state from the live page and fall back to the next configured provider.

## Mandatory execution rule

When the user asks to actually generate or save media, run:

```bash
node skills/agentchat-media-studio/index.js [options] "prompt"
```

Do not claim that media was generated from a prompt alone. A successful result requires:

- `ok: true`;
- at least one item in `artifacts`;
- a machine-generated `receipt.run_id`;
- an existing local artifact path.

If the user only asks for concepts or prompts, do not consume a web quota.

## Task contract

Preferred task-file JSON:

```json
{
  "prompt": "English or Chinese generation prompt",
  "mediaType": "video",
  "providers": ["jimeng", "xiaoyunque", "doubao"],
  "referenceImages": ["C:/absolute/path/product.png"],
  "aspectRatio": "9:16",
  "count": 1,
  "outputDir": "C:/absolute/path/outputs/media",
  "metadata": {
    "project": "fashion-video",
    "product": "wrap-knit-top"
  }
}
```

Run:

```bash
node skills/agentchat-media-studio/index.js --task-file=C:/absolute/path/task.json
```

## Direct CLI

Video from text:

```bash
node skills/agentchat-media-studio/index.js \
  --media-type=video \
  --provider=jimeng,xiaoyunque,doubao \
  --aspect-ratio=9:16 \
  --duration=5 \
  --output-dir=C:/absolute/path/outputs \
  "prompt"
```

Image-to-video:

```bash
node skills/agentchat-media-studio/index.js \
  --media-type=video \
  --image-path=C:/absolute/path/product.png \
  "prompt"
```

Image generation:

```bash
node skills/agentchat-media-studio/index.js \
  --media-type=image \
  --count=1 \
  "prompt"
```

Inspect routing without opening Chrome:

```bash
node skills/agentchat-media-studio/index.js --dry-run --media-type=video "prompt"
```

## Execution workflow

1. Receive a completed generation prompt from the creative skill.
2. Normalize the task and build the provider route.
3. Connect to the persistent Chrome CDP profile.
4. Reuse an existing provider tab when possible.
5. Detect login or exhausted quota before submitting.
6. Select image/video mode.
7. Fill the prompt before uploading references so the upload redraw cannot erase it.
8. Upload absolute-path reference images, then re-locate the editor and verify the prompt was retained.
9. Apply model, aspect-ratio, resolution, and duration controls after upload; stop before submission if a requested duration was not applied.
10. Submit exactly once, then poll the live page for processing, failure, quota, or completed media.
11. Capture `<img>` or `<video>` artifacts, or use the provider's download control.
12. Save files under `outputDir`.
13. Return JSON with provider attempts, artifact paths, and receipt.

### Xiaoyunque fixed flow

The Xiaoyunque adapter uses this exact sequence:

```text
reuse current logged-in tab
→ select video/image mode
→ fill prompt
→ upload all reference images
→ re-find editor and restore prompt if the composer was redrawn
→ select free model
→ set aspect ratio
→ set resolution when the control exists
→ set duration and verify the value
→ close transient dialogs
→ click Generate once
→ wait for completed <video>/<img>
→ save the artifact locally
```

It does not open and close a new Xiaoyunque page for every step. An explicit duration request is never silently replaced by the provider default; automatic-duration mode may use the provider default only when the live page exposes no duration control.

### Doubao fixed flow

The Doubao adapter detects whether video mode is already active before clicking the mode entry, preventing the same control from toggling video mode off. It uses stable action-bar attributes to select `Seedance 2.0 Mini`, opens the generation-parameter panel, applies aspect ratios, maps the live 4–15 second ARIA slider to real seconds, verifies the selected duration, supports hidden multi-image upload inputs, and keeps `--prepare-only` strictly non-submitting.

## Safety and quota behavior

- Stop the fallback chain on a safety rejection.
- Continue to the next provider on quota, authentication, timeout, selector drift, or generation failure.
- If an explicit duration has no visible provider control, return `duration_unavailable` instead of silently submitting the provider's default duration. Automatic-duration mode may continue with the provider default when the page exposes no duration control.
- Duration is adaptive. If the user does not specify one, infer a suitable duration from the creative structure, clamp it to the live provider/model limits, and use the longest suitable value that the current free model exposes. Do not hard-code `5s`.
- Never bypass CAPTCHA, login verification, paid limits, or platform safety controls.
- Do not hard-code claimed daily quota amounts; providers can change them.
- Keep user browser tabs open. The runtime closes only tabs it created.

## UI drift

Provider pages change frequently. Selector lists live in:

```text
providers/index.js
```

If a provider fails with `editor`, `generate_button`, `upload`, or `artifact`, inspect the logged-in page and update only that provider's configuration. Do not rewrite the orchestration or fallback logic.

## Integration with Fashion Video Creative Director

The creative skill should:

1. finish product analysis and creative planning;
2. compile the prompt through its target adapter;
3. create the MediaStudio task JSON;
4. invoke this skill only when the user requests actual generation;
5. report saved artifact paths and `receipt.run_id`.
