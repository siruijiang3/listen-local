"""Ship the exact official tokenizer configuration and parity fixtures."""
import json
from pathlib import Path
import shutil
from transformers import AutoTokenizer
root=Path("public/models/qwen-webgpu")
source=Path(".qa/models/qwen3-0.6b-customvoice")
for name in ("config.json","generation_config.json","tokenizer_config.json","vocab.json","merges.txt"):
    shutil.copyfile(source/name,root/name)
tok=AutoTokenizer.from_pretrained(str(source),local_files_only=True)
tok.backend_tokenizer.save(str(root/"tokenizer.json"))
samples=json.loads(Path(".qa/qwen-inputs.json").read_text(encoding="utf-8"))
fixtures=[]
for sample in samples:
    text=f"<|im_start|>assistant\n{sample['text']}<|im_end|>\n<|im_start|>assistant\n"
    fixtures.append(dict(text=text,ids=tok(text)["input_ids"]))
(root/"tokenizer-fixtures.json").write_text(json.dumps(fixtures,ensure_ascii=False),encoding="utf-8")
print("Tokenizer fixtures",len(fixtures))
