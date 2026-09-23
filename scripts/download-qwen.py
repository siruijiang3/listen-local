"""Anonymous, pinned official model download. No speech/text is uploaded."""
import argparse
import json
import os
import time
from pathlib import Path

os.environ.setdefault("HF_HOME", str(Path(".qa/hf-cache").resolve()))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
from huggingface_hub import snapshot_download

parser = argparse.ArgumentParser()
parser.add_argument("--size", choices=["1.7B", "0.6B"], default="1.7B")
args = parser.parse_args()
repo = f"Qwen/Qwen3-TTS-12Hz-{args.size}-CustomVoice"
target = Path(f".qa/models/qwen3-{args.size.lower()}-customvoice")
meta_path = Path(".qa/qwen-model.json" if args.size == "1.7B" else ".qa/qwen-model-0.6b.json")
if meta_path.exists():
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["repo"] == repo, "Model metadata mismatch"
    revision = meta["revision"]
else:
    revision = {
        "0.6B": "85e237c12c027371202489a0ec509ded67b5e4b5",
        "1.7B": "0c0e3051f131929182e2c023b9537f8b1c68adfe",
    }[args.size]
    meta = {"repo": repo, "revision": revision, "license": "Apache-2.0"}
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
start = time.perf_counter()
snapshot_download(repo_id=repo, revision=revision, local_dir=target, token=False, max_workers=3)
meta.update(downloadSeconds=time.perf_counter()-start, localPath=str(target.resolve()),
            totalFileBytes=sum(p.stat().st_size for p in target.rglob("*") if p.is_file() and ".cache" not in p.parts))
meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
print(json.dumps(meta), flush=True)
