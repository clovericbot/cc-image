<p align="center">
  <img src="https://img.shields.io/badge/Runtime-Bun-f472b6?style=for-the-badge&logo=bun&logoColor=white" />
  <img src="https://img.shields.io/badge/Protocol-Chrome_CDP-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" />
  <img src="https://img.shields.io/badge/Model-Gemini_Pro-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" />
</p>

<h1 align="center">🎨 cc-image</h1>

<p align="center">
  <strong>Generate images through Google Gemini's web interface using pure Chrome DevTools Protocol.</strong><br/>
  No API keys. No Playwright hijack. No puppeteer overhead. Just raw CDP.
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#single-image">Single Image</a> •
  <a href="#batch-generation">Batch</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔌 **Pure CDP** | Direct Chrome DevTools Protocol — no Playwright, no Puppeteer, no temp-dir hijack |
| 🖼️ **Pro Quality** | Automatically verifies Gemini Pro mode (~1792×2400, ~8MB per image) |
| 📦 **Batch Mode** | Generate multiple images in ONE conversation for **style consistency** |
| 🔁 **Auto Retry** | 3-attempt download with re-set `Browser.setDownloadBehavior` each time |
| ✅ **PNG Validation** | Magic byte check + minimum size gate — no corrupted downloads |
| 🎯 **Dual-Layer Download** | Browser-level + Page-level `setDownloadBehavior` for bulletproof file capture |
| 🚀 **Bun Runtime** | Fast startup, native WebSocket, zero config |

## 📋 Prerequisites

- [Bun](https://bun.sh/) runtime (v1.0+)
- Google Chrome launched with remote debugging:
  ```bash
  google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
  # or on macOS:
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
    --remote-debugging-port=9222 \
    --user-data-dir=/tmp/chrome-debug
  ```
- A Google account logged into [Gemini](https://gemini.google.com) in that Chrome instance

## 🚀 Quick Start

```bash
# Clone
git clone https://github.com/clovericbot/cc-image.git
cd cc-image

# Generate a single image
bun scripts/gemini-gen.js "A cat wearing a space helmet, digital art" ./output.png

# Generate a batch (same conversation = consistent style)
bun scripts/gemini-batch.js ./my-prompts/ ./my-output/
```

## 🖼️ Single Image

```bash
bun scripts/gemini-gen.js <prompt_or_file> <output_path> [options]
```

**Arguments:**
| Arg | Description |
|-----|-------------|
| `prompt_or_file` | Text string or path to a `.txt`/`.md` prompt file |
| `output_path` | Where to save the generated PNG |

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `9222` | Chrome CDP port |
| `--user` | `1` | Gemini user index (`/u/0/`, `/u/1/`, etc.) |
| `--new-chat` | `false` | Start a fresh Gemini conversation |
| `--min-wait` | `20` | Minimum seconds to wait after sending prompt |
| `--dl-wait` | `20` | Max seconds to wait for download per attempt |

**Examples:**
```bash
# From text
bun scripts/gemini-gen.js "Infographic about climate change" ~/Downloads/climate.png

# From file, new conversation, custom port
bun scripts/gemini-gen.js ./prompts/cover.txt ./output/cover.png --new-chat --port 9223

# Continue in existing conversation (for style consistency)
bun scripts/gemini-gen.js ./prompts/page2.txt ./output/page2.png
```

## 📦 Batch Generation

```bash
bun scripts/gemini-batch.js <prompts_dir> <output_dir> [options]
```

Generates all images in a **single Gemini conversation** — critical for visual consistency across a series.

**Prompt files:** Numbered `.txt` or `.md` files in the prompts directory:
```
prompts/
├── 01-cover.txt
├── 02-context.txt
├── 03-details.txt
└── 04-conclusion.txt
```

**Output:** Each prompt produces `<name>.png` in the output directory.

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `9222` | Chrome CDP port |
| `--user` | `1` | Gemini user index |
| `--min-wait` | `20` | Min wait per image |
| `--dl-wait` | `20` | Download timeout per attempt |
| `--notify` | — | Command to run after each image: `cmd "name" "path" idx total` |

**Example with notification:**
```bash
bun scripts/gemini-batch.js ./prompts/ ./output/ \
  --notify 'echo "Generated: $1 ($3/$4)"'
```

## ⚙️ How It Works

```
┌─────────────────────────────────────────────────────────┐
│                    cc-image Pipeline                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. Connect to Chrome via CDP (WebSocket)               │
│     ├── Browser-level WS  (/json/version)               │
│     └── Page-level WS     (/json/list → tab)            │
│                                                         │
│  2. Navigate to Gemini → Dismiss popups → Verify Pro    │
│                                                         │
│  3. Send prompt                                         │
│     ├── Focus .ql-editor / [contenteditable]            │
│     ├── Input.insertText (not clipboard paste)          │
│     └── Click "Send message" button (aria-label)        │
│                                                         │
│  4. Wait for generation                                 │
│     ├── Min-wait timer (default 20s)                    │
│     ├── Poll: DL button count increased?                │
│     └── Poll: "Stop response" button gone?              │
│                                                         │
│  5. Download                                            │
│     ├── Browser.setDownloadBehavior (browser WS) ←KEY   │
│     ├── Page.setDownloadBehavior (page WS)              │
│     ├── 500ms delay (race condition prevention)         │
│     ├── scrollIntoView → 500ms → click (two-step)      │
│     ├── Poll directory for new .png file                │
│     ├── Wait for file size to stabilize                 │
│     └── Validate PNG header (0x89 0x50) + min 100KB    │
│                                                         │
│  6. Retry up to 3x if download fails                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 🔑 Key Technical Details

**Why Browser-level WebSocket?**

The `Download full size image` button in Gemini triggers a **navigation** to `lh3.googleusercontent.com`, not a standard download. `Browser.setDownloadBehavior` intercepts this navigation and saves the file — but it **must** be sent on the browser-level WebSocket (obtained via `/json/version`), not the page-level one. This was the #1 bug that took weeks to diagnose.

**Why dual-layer setDownloadBehavior?**

We set download behavior on both the browser WS (`Browser.setDownloadBehavior`) and the page WS (`Page.setDownloadBehavior`) as a belt-and-suspenders approach. Either alone can fail silently depending on Chrome version and tab state.

**Why two-step scroll + click?**

Combining `scrollIntoView` and `click()` in a single `Runtime.evaluate` call sometimes fires the click before the scroll completes. Splitting them with a 500ms gap ensures the button is visible and interactable.

## 🔧 Troubleshooting

| Problem | Solution |
|---------|----------|
| `Cannot open Gemini` | Ensure Chrome is running with `--remote-debugging-port=9222` and Gemini is accessible |
| `timeout: Runtime.evaluate` | Page may have navigated away. Use `--new-chat` to start fresh |
| Download fails 3x | Check if Gemini generated an image (sometimes it outputs text only). Retry with `--new-chat` |
| Wrong Gemini account | Adjust `--user` flag (`0` = first profile, `1` = second, etc.) |
| Images are 1024×1024 (~1MB) | You're on Gemini Fast, not Pro. Script auto-checks but can't force-switch in all cases |
| `Page.setDownloadBehavior` deprecated warning | Safe to ignore — we use it as fallback alongside the Browser-level call |

## 🏗️ Use as an OpenClaw Skill

Drop the entire directory into your OpenClaw skills folder:

```bash
cp -r cc-image ~/.openclaw/skills/
```

The `SKILL.md` frontmatter makes it auto-discoverable by OpenClaw agents.

## 📄 License

MIT — do whatever you want with it.

---

<p align="center">
  Built with frustration, debugged with patience, powered by raw CDP. 🔧
</p>
