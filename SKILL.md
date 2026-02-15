---
name: cc-image
description: Generate images via Google Gemini Web using pure Chrome CDP automation. Handles prompt input, image generation waiting, and reliable file downloads to specified directories. Supports single image and batch generation (multiple prompts in one conversation for style consistency). Use when generating images with Gemini, creating XHS (Xiaohongshu) infographic series, or any task requiring browser-automated image generation from Gemini. Triggers on requests like "生成图片", "生图", "generate image", "XHS images", "batch generate".
---

# cc-image — Gemini Image Generation via CDP

Generate images through Google Gemini's web interface using pure Chrome DevTools Protocol. Downloads go directly to your specified directory via `Browser.setDownloadBehavior`.

## Prerequisites

- Chrome debug instance with `--remote-debugging-port=9222`
- Gemini account logged in (default: `/u/1/`)
- `bun` runtime

## Single Image

```bash
bun scripts/gemini-gen.js "Your prompt" /path/to/output.png
bun scripts/gemini-gen.js prompt.txt ~/Downloads/cover.png --new-chat
```

Options: `--port 9222` `--user 1` `--new-chat` `--min-wait 20` `--dl-wait 20`

## Batch (Same Conversation = Consistent Style)

```bash
bun scripts/gemini-batch.js ./prompts/ ./output/
```

Prompts dir: numbered `.txt`/`.md` files (`01-cover.md`, `02-context.md`, ...).
All run in ONE conversation for visual consistency. Output: `<name>.png`.

Extra options: `--notify <cmd>` — called after each image: `cmd "name" "path" idx total`

## How It Works

1. Connect to Chrome CDP → navigate to Gemini new chat → verify Pro mode
2. Focus input → `Input.insertText` → click "Send message"
3. Min-wait → poll until DL button count increases + "Stop response" gone
4. `Browser.setDownloadBehavior` (browser-level WS) + `Page.setDownloadBehavior` (page-level WS) to target dir → scroll → click download → wait for file → validate PNG header
5. Retry up to 3x if download fails (re-set behavior + re-click each time)

## Key Details

- **Dual-layer download**: Browser WS (`/json/version`) + Page WS for bulletproof file capture
- **Button detection**: `aria-label="Download full size image"` (innerText is empty)
- **DL count tracking**: Each image adds one button; compare before/after
- **500ms delay**: Between `setDownloadBehavior` and click, prevents race condition
- **Two-step interaction**: scroll first, 500ms pause, then click (prevents premature click)
- **PNG validation**: Checks magic bytes (0x89 0x50) + min 100KB size before accepting
- **No Playwright**: Pure CDP avoids temp-dir hijack issues
