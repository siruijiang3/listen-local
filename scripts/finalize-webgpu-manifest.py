import hashlib
import json
from pathlib import Path
root=Path("public/models/qwen-webgpu")
components=["decoder","embeddings","cache","step","predictor","predictor-step","residual"]
files=[]
for component in components:
    files+=json.loads((root/(component+"-export.json")).read_text(encoding="utf-8"))["records"]
fixtures=json.loads((root/"prefill-fixtures.json").read_text(encoding="utf-8"))
reference_files=sorted({fixture[key] for fixture in fixtures for key in ("input","logits","hidden","predictor")})
step_fixtures=json.loads((root/"step-fixtures.json").read_text(encoding="utf-8"))
reference_files += [fixture["file"] for fixture in step_fixtures]
for name in ["config.json","generation_config.json","tokenizer.json","tokenizer_config.json","tokenizer-fixtures.json","decoder-input.i64","decoder-reference.f32","prefill-fixtures.json","step-fixtures.json"]+reference_files:
    data=(root/name).read_bytes()
    files.append(dict(file=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest()))
version=hashlib.sha256(json.dumps([(f["file"],f["sha256"]) for f in files]).encode()).hexdigest()[:16]
meta=json.loads(Path(".qa/qwen-model-0.6b.json").read_text(encoding="utf-8"))
manifest=dict(version=version,source=meta["repo"],revision=meta["revision"],modelBytes=sum(f["bytes"] for f in files),
              files=files,generatorPrecision="fp16 with fp32 text projection, attention accumulation, and predictor SwiGLU/down projection",decoderPrecision="fp32",decoderFrames=37,
              runtime="onnxruntime-web 1.30.0",status="experimental-unvalidated")
(root/"manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
print(version,manifest["modelBytes"])
