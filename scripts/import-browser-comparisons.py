"""Import UI-exported frame comparisons; normalize review copies only."""
import json
import shutil
from pathlib import Path

import numpy as np
import soundfile as sf

root = Path(__file__).resolve().parents[1]
target = root / "public/auditions/qwen-realtime"
manifest_path = target / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
runs = json.loads((root / ".qa/realtime/webgpu-frames.json").read_text(encoding="utf-8"))["runs"]
for run in runs:
    request = run["request"]
    clip = next(c for c in manifest["clips"] if c["speaker"] == request["speaker"] and c["frames"] == request["frames"])
    assert clip["text"] == "".join(request["segments"])
    source = Path.home() / "Downloads" / f"qwen-{run['runId']}.wav"
    pcm, rate = sf.read(source, dtype="float32")
    assert rate == 24000 and pcm.ndim == 1 and np.isfinite(pcm).all()
    assert abs(len(pcm) / rate - run["received"]) < 1e-5
    name = f"browser-{request['speaker']}-{request['frames']}"
    shutil.copyfile(source, target / f"{name}-raw.wav")
    active = pcm[np.abs(pcm) > .005]
    rms = float(np.sqrt(np.mean(active ** 2))) if len(active) else 0.
    gain = min(.1 / max(rms, 1e-8), .94 / max(float(np.max(np.abs(pcm))), 1e-8), 8.)
    sf.write(target / f"{name}.wav", pcm * gain, rate, subtype="PCM_16")
    clip.update(browserFile=f"{name}.wav", browserRawFile=f"{name}-raw.wav",
                browserGainDb=float(20 * np.log10(gain)), browserSeconds=len(pcm) / rate,
                browserRunId=run["runId"], browserQuality="awaiting-human-review")
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Imported and verified {len(runs)} browser comparison clips")
