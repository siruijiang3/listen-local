"""Generate reproducible auditions with the unmodified official qwen-tts package.
Short passages are passed whole; long passages are split only at paragraph breaks.
No G2P/translation/rewriting, time-stretching or pitch correction is applied.
"""
import argparse
import hashlib
import json
import os
import platform
import time
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

os.environ.setdefault("HF_HOME", str(Path(".qa/hf-cache").resolve()))
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

parser = argparse.ArgumentParser()
parser.add_argument("--size", choices=["1.7B", "0.6B"], default="1.7B")
parser.add_argument("--cpu-threads", type=int, default=6)
parser.add_argument("--output-dir", help="Separate directory for diagnostic runs")
parser.add_argument("--only", nargs="*", help="Sample IDs (default: all)")
parser.add_argument("--voices", nargs="*", default=["Serena", "Uncle_Fu", "Aiden"])
args = parser.parse_args()
root = Path(args.output_dir or ("public/auditions/qwen3" if args.size == "1.7B" else "public/auditions/qwen3-0.6b"))
root.mkdir(parents=True, exist_ok=True)
source = json.loads(Path(".qa/qwen-inputs.json").read_text(encoding="utf-8"))
meta_path = Path(".qa/qwen-model.json" if args.size == "1.7B" else ".qa/qwen-model-0.6b.json")
model_meta = json.loads(meta_path.read_text(encoding="utf-8"))
assert model_meta["repo"] == f"Qwen/Qwen3-TTS-12Hz-{args.size}-CustomVoice"
manifest_path = root / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"clips": []}
settings = {"dtype": "bfloat16", "attention": "sdpa", "speed": "model default", "seed": 42,
            "instruction": "", "normalization": "whole-clip active RMS -20 dBFS, peak <= 0.94",
            "longChunking": "original paragraphs, no added silence"}
device = "cuda:0" if torch.cuda.is_available() else "cpu"
if device == "cpu":
    raise RuntimeError("CUDA is unavailable. Not silently changing model or inference configuration.")
if args.cpu_threads < 1:
    raise ValueError("--cpu-threads must be positive")
torch.set_num_threads(args.cpu_threads)
manifest.update(model=model_meta["repo"], revision=model_meta["revision"], license="Apache-2.0",
                implementation="Official qwen-tts Python package", packageVersion=version("qwen-tts"),
                torchVersion=torch.__version__, device=torch.cuda.get_device_name(0),
                modelBytes=model_meta["totalFileBytes"], downloadSeconds=model_meta["downloadSeconds"],
                platform=platform.platform(), settings=settings)
started = time.perf_counter()
model = Qwen3TTSModel.from_pretrained(model_meta["localPath"], device_map=device,
                                    dtype=torch.bfloat16, attn_implementation="sdpa")
manifest["loadSeconds"] = time.perf_counter() - started
print("MODEL_READY " + json.dumps({"loadSeconds": manifest["loadSeconds"], "device": manifest["device"]}), flush=True)

def save_manifest():
    temp = root / "manifest.pending.json"
    temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(manifest_path)

save_manifest()
# Deliver the first common passage in each language before the remaining cases.
source.sort(key=lambda s: (bool(s.get("long")), not s["id"].endswith("story")))
for sample in source:
    if args.only and sample["id"] not in args.only:
        continue
    voices = [v for v in args.voices if (v != "Aiden") == (sample["language"] == "zh")]
    for speaker in voices:
        clip_id = sample["id"] + "-" + speaker.lower()
        fingerprint = hashlib.sha256(json.dumps([sample, speaker, model_meta["revision"], settings], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        if any(c["id"] == clip_id and c.get("fingerprint") == fingerprint and (root / c["file"]).exists() for c in manifest["clips"]):
            print("SKIP " + clip_id, flush=True)
            continue
        paragraphs = [p for p in sample["text"].split("\n\n") if p.strip()] if sample.get("long") else [sample["text"]]
        print("GENERATING " + clip_id + " paragraphs=" + str(len(paragraphs)), flush=True)
        generated, parts = [], []
        torch.cuda.reset_peak_memory_stats()
        synthesis_start = time.perf_counter()
        for index, paragraph in enumerate(paragraphs):
            torch.manual_seed(42 + index)
            tick = time.perf_counter()
            with torch.inference_mode():
                wavs, rate = model.generate_custom_voice(text=paragraph,
                    language="Chinese" if sample["language"] == "zh" else "English",
                    speaker=speaker, instruct="", non_streaming_mode=True, max_new_tokens=4096)
            torch.cuda.synchronize()
            pcm = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
            if len(pcm) == 0 or not np.isfinite(pcm).all():
                raise RuntimeError("Invalid audio: " + clip_id)
            elapsed = time.perf_counter() - tick
            parts.append({"text": paragraph, "seconds": len(pcm)/rate, "generationSeconds": elapsed})
            generated.append(pcm)
            print(f"PART {clip_id} {index+1}/{len(paragraphs)} audio={len(pcm)/rate:.1f}s wall={elapsed:.1f}s", flush=True)
        elapsed = time.perf_counter() - synthesis_start
        pcm = np.concatenate(generated)
        peak = float(np.abs(pcm).max())
        active = pcm[np.abs(pcm) > 0.005]
        rms = float(np.sqrt(np.mean(active ** 2))) if len(active) else 0.0
        gain = min(0.1 / max(rms, 1e-8), 0.94 / max(peak, 1e-8), 8.0)
        pcm *= gain
        filename = clip_id + "-" + fingerprint[:10] + ".wav"
        output = root / filename
        sf.write(output, pcm, rate, subtype="PCM_16")
        entry = {"id": clip_id, "fingerprint": fingerprint, "file": filename,
                 "cpuThreads": args.cpu_threads,
                 "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                 "sampleId": sample["id"], "title": sample["title"], "category": sample["category"],
                 "language": sample["language"], "long": bool(sample.get("long")),
                 "text": sample["text"], "speaker": speaker, "sampleRate": rate,
                 "seconds": len(pcm)/rate, "generationSeconds": elapsed,
                 "peakGpuBytes": torch.cuda.max_memory_allocated(), "gainDb": 20*np.log10(gain),
                 "parts": parts, "createdAt": datetime.now(timezone.utc).isoformat(),
                 "qualityStatus": "awaiting-human-review"}
        manifest["clips"] = [c for c in manifest["clips"] if c["id"] != clip_id] + [entry]
        save_manifest()
        print("SAVED " + filename, flush=True)
print("DONE clips=" + str(len(manifest["clips"])), flush=True)
