"""Download reference source for review; never execute it here."""
import json
from pathlib import Path
import urllib.request

root = Path(".qa/onnx-reference")
root.mkdir(parents=True, exist_ok=True)
repo = "onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice"
meta = json.load(urllib.request.urlopen("https://huggingface.co/api/models/"+repo))
(root/"metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
print("revision", meta["sha"])
for file in meta["siblings"]:
    name = file["rfilename"]
    if name.endswith(".py") or name in ("README.md", "STATUS.md", "config.json", "LICENSE"):
        data = urllib.request.urlopen(f"https://huggingface.co/{repo}/resolve/{meta['sha']}/{name}").read()
        target = root/name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        print(name, len(data))
print("FILES", [f["rfilename"] for f in meta["siblings"]])
