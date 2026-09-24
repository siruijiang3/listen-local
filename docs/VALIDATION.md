# Validation — 0.1.x preview

Measured on 2026-09-23, Windows 11 x64, Intel i9-13900HX, NVIDIA RTX 4060 Laptop 8 GB. Runtime: Python 3.12, Torch 2.6.0, Faster Qwen3-TTS 0.4.0, Qwen-TTS-HF 0.1.1.post1. Model: pinned 0.6B CustomVoice revision in the model manifest. Original benchmark texts and raw timings are under `measurements/`.

## 0.1.2 reader and seek update

The reader uses actual persisted fragment ranges, not estimated word timestamps. Older recordings retain their original segmentation, including fragments spanning natural paragraphs. The UI labels each active fragment with its number, time range and any cross-paragraph span. New jobs stop at CR/LF paragraph boundaries and split long paragraphs with the existing language-specific limits. No existing job is resegmented or regenerated.

Seven frontend tests and seventeen Python tests pass. Added regressions cover delayed AudioContext close/module load races, stale progress and aborted PCM reads, paused seeks and exact endpoints, source/audio interval boundaries, UTF-16 source ranges, zero-length fragments, gaps and shrinking availability, and paragraph source preservation. TypeScript production build and formatting checks pass.

The packaged 0.1.2 core generated three distinct paragraphs for each of Serena, Uncle Fu and Aiden on CUDA. Each produced exactly three completed fragments with matching source/sample ranges; partial reader indices were observed during generation. Audio durations were 11.92 / 15.60 / 10.96 seconds and generation times 5.097 / 6.617 / 4.676 seconds. These are regression samples, not a new statistical latency benchmark. See `measurements/paragraph-generation-0.1.2.json`.

Native reader interaction and continuous-playback results are recorded separately below when the final run finishes; interrupted development runs are not counted as 30-minute passes.

A separate headless Edge functional test exercised the React reader against the real packaged CUDA core while four different natural paragraphs were being generated. It verified pending-text clicks, frozen drag range during growth, synthesis continuing while playback was paused, and all four newly completed paragraphs becoming clickable at their measured sample starts. The job produced 66.96 seconds of audio in 29.007 seconds of generation with no JavaScript errors. This is functional browser evidence, distinct from the native WebView2 continuous-playback run. See `measurements/live-reader-0.1.2.json` and `scripts/check-reader-live.cjs`.

## Native engine measurements

| Voice | GPU warm first-block P95 (20 samples) | GPU aggregate RTF | CPU RTF (one short sample, 6 threads) |
| --- | ---: | ---: | ---: |
| Serena | 0.358 s | 0.461 | 5.224 |
| Uncle Fu | 0.346 s | 0.452 | 3.944 |
| Aiden | 0.360 s | 0.459 | 4.200 |

GPU load/warm-up: 8.45 s; CPU load: 7.05 s. These are worker prepare times with local cached files, not installation-to-first-audio times. CPU first completed segments took 15.05 / 21.14 / 9.75 seconds respectively. CPU used the standalone CPU pack and FP32 without CUDA libraries. These short samples establish execution and baseline speed, not statistical CPU performance guarantees.

**First-block timing is received PCM, not audible speaker output.** The complete UI warm first-sound P95 requirement remains unverified. The measured GPU generation throughput meets RTF <= 0.8 on these samples. It must not be substituted for a three-voice 30-minute playback acceptance test.

## Automated and integration checks

- TypeScript build and bounded PCM conversion tests pass.
- Python tests cover EPUB spine order, GB18030, exact source ranges and tail retention, crash checkpoints, rename/commit playback races, simulated disk-full commit failure, completed download recovery, unsafe ZIP paths, fail-closed export, actual FFmpeg M4B/MP3/ZIP encoding, authenticated share links and HTTP Range 206/416.
- Queue test generates over 29 seconds with playback position unchanged and confirms resume preserves completed segments.
- Windows NSIS installer builds locally. CI repeats lightweight tests and the Windows build; GPU is not mocked as a CI success.

## Longer run, installed core and memory

Serena generated 72 segments totaling **2,990.32 s (49 min 50 s)**. Measured generation took **1,277.94 s**, RTF **0.42736**. Time from the final PCM segment write to all export files finishing was **58.24 s** (M4B plus chapter MP3/ZIP). The source was a repeated original 120-paragraph Chinese passage. This is throughput/export evidence; human end-to-end narration quality is a separate check.

The NSIS installer completed with exit code 0 in an isolated directory on the development PC. Its installed standalone core then ran with only Windows System32 on PATH, used the standalone CPU pack, generated two English chapters, encoded all formats, served an authenticated download and HTTP Range 206, released its model, and exited with code 0. This verifies absence of a required development Python on PATH; it does not turn this PC into a clean Windows machine.

An empty installed app with no model used **464,338,944 bytes** total working set across Tauri, WebView2, the packaged core and console helper at one idle sample. Summing working sets can count shared pages multiple times. This is not private memory or a long-duration leak test.

Additional CPU 4/8-thread measurements are in `measurements/cpu-threads*.json`. Eight threads were faster across this small sample in aggregate (voice RTFs 4.118 / 3.460 / 3.577). The UI supports selecting eight; the general default remains a conservative six pending representative long-text tuning across CPUs. The 8-thread worker reached **5,884,964,864 bytes peak working set**, excluding UI/core. Samples are too small to establish a universal optimum.

The installed core also completed a fresh network download of the published CPU pack and all fixed official model files, including SHA-256 checks and extraction, in **115.42 s** on this connection. Generating and exporting from those downloaded files passed a subsequent standalone smoke test. Network speed is not a hardware performance guarantee.

The standalone CUDA pack passed all three voices. Its first prepare in a new extracted environment took **101.58 s**; the immediate repeat took **7.77 s**. The reason for this first-use difference was not isolated. Do not assume the short warm preparation time is a cold-start guarantee. GPU worker peak working set was about **2.62 GB**; this is host RAM, not VRAM.

The first public Windows CI run passed: https://github.com/siruijiang3/listen-local/actions/runs/35933797460 .

A real CPU task was interrupted through the tray-equivalent shutdown API, restarted as **paused**, resumed, and exported successfully. One completed segment remained byte-for-byte unchanged; all three segments were present at completion. See `measurements/recovery.json` and its runnable validation script. This covers controlled exit during inference, not every forced-crash phase.

Several development-preview playback sessions ran without reported underruns, but were interrupted by development hot reload. **There is no valid uninterrupted 30-minute playback pass in this release record.** The 49-minute generated archive is not a substitute for that test. Native WebView2 playback acceptance remains open.

## Download sizes

| Artifact | Bytes |
| --- | ---: |
| Windows installer | 43,922,124 |
| CPU runtime ZIP | 429,705,945 |
| CUDA runtime ZIP (three download parts) | 2,755,622,299 |
| Official model files | approximately 2,498,383,610 |

Installer size and SHA-256 are recorded with the release assets. Extracted disk use exceeds compressed download sizes. Runtime packs retain upstream dependency metadata, including Qwen's demo-related transitive dependencies; further pruning requires import/regression testing. No claim that the full installation is only tens of MB is made.

## Acceptance still requiring real devices or additional runs

- Android, iPhone and iPad: camera QR scan, real Wi-Fi transfer, import into chosen player and offline listening.
- Clean Windows without developer tools: installation, absent-WebView2 bootstrap and first official download workflow.
- Native WebView2 three-voice warm audible first-sound P95 and 30-minute uninterrupted playback per voice.
- Broader GPU/CPU compatibility; representative long-text CPU thread-count tuning and human listening assessment of long-text endings.
- OS-level disk-full recovery, forced-exit recovery during every phase, and extended memory/resource-leak measurements. Unit fault injection is recorded separately from these physical tests.

The release is a preview while these acceptance items are open. Source delivery and a downloadable installer do not imply all hardware acceptance criteria have passed.
