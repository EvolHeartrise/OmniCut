# OmniCut

Multi-stream Twitch DVR director tool - capture, seek, and switch between multiple live perspectives in real-time.

## What It Does

OmniCut lets you pull in multiple Twitch live streams simultaneously, recording them all to disk as HLS segments. You can then seek backwards through any stream's history, scrub the timeline, and snap back to live - like a DVR for multi-perspective Twitch events.

## Features

- **Capture any Twitch stream** - Just enter a channel name to start recording
- **Up to 6+ simultaneous streams** - All recording independently to disk
- **DVR-style seeking** - Scrub backwards through the full recording history of any stream
- **Frame-accurate seeking** - 1-second keyframe intervals for precise navigation
- **Snap to LIVE** - One click to jump back to real-time
- **Focus mode** - Click or press 1-6 to enlarge a specific stream
- **Real-time updates** - SSE-powered live segment count and status updates

## Prerequisites

- [Bun](https://bun.sh) (latest)
- [FFmpeg](https://ffmpeg.org/) (must be in PATH)
- [Streamlink](https://streamlink.github.io/) (`pip install streamlink`)

## Getting Started

```bash
# Clone the repo
git clone https://github.com/EvolHeartrise/OmniCut.git
cd OmniCut

# Install dependencies
bun install

# Start the dev server
bun run dev
```

Then open `http://localhost:5173` and start adding Twitch channels.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1`-`6` | Focus/unfocus stream by position |
| `Escape` | Unfocus all streams |

## Architecture

```
streamlink (get HLS URL) → FFmpeg (re-segment to local HLS) → SvelteKit serves HLS → hls.js plays in browser
```

Each captured stream writes to `recordings/{id}/` with a growing `.m3u8` playlist and `.ts` segment files. The SvelteKit backend manages capture processes and serves the HLS files. The frontend uses hls.js for DVR-style playback with frame-accurate seeking.

## Tech Stack

- **Frontend**: SvelteKit + Svelte 5 + hls.js
- **Backend**: SvelteKit server routes (Node adapter)
- **Capture**: Streamlink + FFmpeg
- **Runtime**: Bun

## License

MIT
