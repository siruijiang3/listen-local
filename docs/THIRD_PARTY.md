# Third-party software and model sources

Application source is GPL-3.0-or-later; see `LICENSE`. Third-party components retain their own licenses. Release runtime archives preserve installed distribution metadata/license files; dependencies are listed exactly in the committed lock files.

| Component | License / source |
| --- | --- |
| React | MIT — https://github.com/facebook/react |
| Tauri | MIT / Apache-2.0 — https://github.com/tauri-apps/tauri |
| Python 3.12.10 | PSF — https://www.python.org/downloads/release/python-31210/ |
| Qwen3-TTS / Qwen-TTS-HF | Apache-2.0 — https://github.com/QwenLM/Qwen3-TTS |
| Qwen3-TTS 0.6B CustomVoice | Apache-2.0 — https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice |
| Faster Qwen3-TTS 0.4.0 | MIT — https://github.com/andimarafioti/faster-qwen3-tts |
| PyTorch | BSD-style — https://github.com/pytorch/pytorch |
| Transformers | Apache-2.0 — https://github.com/huggingface/transformers |
| pypdf | BSD-3-Clause — https://github.com/py-pdf/pypdf |
| python-qrcode | BSD — https://github.com/lincolnloop/python-qrcode |
| imageio-ffmpeg | BSD-2-Clause — https://github.com/imageio/imageio-ffmpeg |
| Bundled FFmpeg 7.1 executable | GPL v3 build — https://www.gyan.dev/ffmpeg/builds/ and https://ffmpeg.org/download.html |

FFmpeg is a separate, unmodified executable from the Windows `imageio-ffmpeg==0.6.0` wheel (`ffmpeg-win-x86_64-v7.1.exe`, Gyan essentials build). Its `-version` output identifies enabled components, including libmp3lame. Source: https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz ; build provenance: https://github.com/imageio/imageio-binaries and https://github.com/GyanD/codexffmpeg . Release maintainers must retain component notices and provide the corresponding source/build materials required by redistributed binaries.

Model revision: `85e237c12c027371202489a0ec509ded67b5e4b5`. The downloadable model manifest records every file's official revision URL and SHA-256. Downloaded weights are not part of the application Git repository.

Earlier experimental source and its notices remain in `public/THIRD_PARTY.txt` and `src/vendor/`; none of those browser inference engines or voice packages are bundled with the desktop application.
