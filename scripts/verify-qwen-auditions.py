"""Check generated artifacts, not intelligibility or subjective listening quality."""
import argparse
import hashlib
import json
import sys
import wave
from array import array
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--size", choices=["1.7B", "0.6B"], default="1.7B")
args = parser.parse_args()
root = Path("public/auditions/qwen3" if args.size == "1.7B" else "public/auditions/qwen3-0.6b")
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
assert manifest["model"] == f"Qwen/Qwen3-TTS-12Hz-{args.size}-CustomVoice"
samples = {s["id"]: s for s in json.loads(Path(".qa/qwen-inputs.json").read_text(encoding="utf-8"))}
expected = {(s["id"], v) for s in samples.values() for v in (["Serena", "Uncle_Fu"] if s["language"] == "zh" else ["Aiden"])}
assert {(c["sampleId"], c["speaker"]) for c in manifest["clips"]} == expected, "Incomplete audition matrix"
assert len(manifest["clips"]) == len(expected), "Duplicate clips"
for clip in manifest["clips"]:
    sample = samples[clip["sampleId"]]
    assert clip["text"] == sample["text"], "Original text modified"
    assert "\n\n".join(p["text"] for p in clip["parts"]) == sample["text"], "Missing or repeated input paragraph"
    file = root / clip["file"]
    assert hashlib.sha256(file.read_bytes()).hexdigest() == clip["sha256"], "File hash mismatch"
    with wave.open(str(file), "rb") as wav:
        assert wav.getnchannels() == 1 and wav.getsampwidth() == 2
        assert wav.getframerate() == clip["sampleRate"]
        assert abs(wav.getnframes()/wav.getframerate() - clip["seconds"]) < 0.001
        assert wav.getnframes() > 0
        pcm = array("h", wav.readframes(wav.getnframes()))
        if sys.byteorder != "little":
            pcm.byteswap()
        peak = max(abs(v) for v in pcm)
        assert 256 < peak <= 30803, "Silent audio or peak normalization exceeded"
        assert abs(sum(p["seconds"] for p in clip["parts"]) - clip["seconds"]) < 0.001
    assert clip["generationSeconds"] > 0
print(f"Verified {len(expected)} WAVs: original input coverage, hashes, PCM headers, sample rates, durations, non-silence and peak bounds.")
print("Not verified: spoken completeness, pronunciation, accent, naturalness. Human review is required.")
