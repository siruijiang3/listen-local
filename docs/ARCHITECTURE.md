# Architecture

Listen Local is a Windows desktop app. WebView2 renders the React UI; it never runs a neural network.

## Processes and ownership

1. Tauri owns the window, tray and the lifetime of `listen-core.exe`.
2. The lightweight Python core owns the SQLite library, imports, task queue, files, exports and optional LAN download server. It does not import Torch.
3. A separate Python runtime process owns exactly one Qwen model. GPU uses Faster Qwen3-TTS CUDA graphs; CPU uses the non-graph Qwen implementation. The core releases the process five minutes after work ends.

There is one generation queue. Playback reads PCM from disk independently, including the growing current segment. Pausing playback does not stop synthesis. Generation pause/cancel takes effect at the next natural-segment boundary; explicit application exit has a bounded graceful shutdown and discards unfinished work.

## Protocol 1

The core announces `{protocol, port, token}` once on stdout. Tauri exposes this only to its local window. The core binds an ephemeral port on `127.0.0.1`; every request requires `Authorization: Bearer <token>`. Origins are restricted to the packaged application and localhost development server.

- `GET /v1/state`: library, task, setup and engine status.
- `POST /v1/import`, `/save_book`, `/book`: import preview and immutable source revisions.
- `POST /v1/generate`, `/pause`, `/resume`, `/cancel`, `/played`: task and playback controls.
- `GET /v1/audio?job=...&offset=...&count=...`: bounded PCM16 little-endian data, 24 kHz mono. Offset/count are bytes; offsets must align to a sample.
- `POST /v1/settings`, `/install`, `/release`: library/runtime settings and pinned downloads.
- `POST /v1/copy_export`, `/share`, `/unshare`: completed artifacts only.
- `POST /v1/shutdown`: application-owned service shutdown.

The engine uses UTF-8 JSON lines on stdin/stdout with `protocol: 1`. Requests are `prepare`, `generate` and `quit`; replies are `ready`, `audio`, `done` or `error`. Audio messages contain base64 PCM16. Logs go to stderr and never enter the protocol. GPU replies contain incremental chunks; CPU replies contain a completed natural segment. A CPU segment is not advertised as token-streaming.

## Durable state

SQLite schema version 1 contains books, jobs, segments and exports. Source offsets cover every character without overlapping or dropping tails. Each job freezes the book version, voice and generation parameters. Completed segment files are fsynced and atomically renamed before their database commit. Restart marks interrupted work paused and resets only unfinished segments. A crash between rename and commit safely regenerates that segment.

All audio stays in files. AudioWorklet has a 32-second ring and the existing 0.5-second start threshold; the UI feeds less than 24 seconds ahead. The core never waits for playback credit. Live playback is an optional consumer of the same archived PCM used for export.

M4B and MP3 are encoded through FFmpeg pipes; the whole book is never assembled as a JS array or Python bytes object. Export metadata becomes visible only after every artifact is finalized and hashed. Interrupted exports can be retried without regenerating completed speech.

## LAN sharing

The separate LAN listener has no generation/settings APIs. It is started by an explicit share action and exposes only one job's completed artifacts behind a random capability URL. It supports single HTTP byte ranges, `HEAD`, ETags and escaped download names. It closes on stop-sharing or exit. This is for a trusted private LAN; no router forwarding, public hosting or cloud sync is configured.

## Packaging

The application uses system WebView2. The core is built in a separate environment with PyInstaller, excluding Torch and all browser model runtimes. CPU/CUDA packs contain embeddable Python and fixed dependencies; a CUDA pack can execute CPU fallback. Both flavors share the same model directory. SHA-256-checked resources are downloaded only when requested.

`src/`, older `scripts/` and the research Markdown files preserve earlier experiments. They are outside the desktop build graph and are not installer resources.
