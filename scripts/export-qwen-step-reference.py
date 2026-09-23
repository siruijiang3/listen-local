"""Independent official FP32 next-step references, without mutating export models."""
import json
import argparse
import os
from pathlib import Path
os.environ["HF_HUB_OFFLINE"]="1"
os.environ["TRANSFORMERS_OFFLINE"]="1"
import torch
from qwen_tts import Qwen3TTSModel
torch.set_num_threads(4)
parser=argparse.ArgumentParser();parser.add_argument("--output",default="public/models/qwen-webgpu")
root=Path(parser.parse_args().output);root.mkdir(parents=True,exist_ok=True)
model=Qwen3TTSModel.from_pretrained(".qa/models/qwen3-0.6b-customvoice",device_map="cpu",dtype=torch.float32,attn_implementation="eager")
class Captured(Exception): pass
captured={}
def capture(**kwargs):
    captured.update(kwargs)
    raise Captured()
model.model.talker.generate=capture
fixtures=json.loads(Path("public/models/qwen-webgpu/prefill-fixtures.json").read_text(encoding="utf-8"))
records=[]
with torch.inference_mode():
    talker=model.model.talker
    pad=talker.text_projection(talker.get_text_embeddings()(torch.tensor([[model.model.config.tts_pad_token_id]])))
    for fixture in fixtures:
        captured.clear()
        try: model.generate_custom_voice(text=fixture["text"],speaker=fixture["speaker"],language=fixture["language"],instruct="",non_streaming_mode=True)
        except Captured: pass
        x=captured["inputs_embeds"];size=x.shape[1]
        initial=talker.model(inputs_embeds=x,position_ids=torch.arange(size).view(1,1,size).expand(3,1,size).contiguous(),attention_mask=captured["attention_mask"],use_cache=True,return_dict=True)
        codes=torch.tensor([fixture["codes"]])
        embedded=talker.model.codec_embedding(codes[:,0])
        for index in range(15): embedded=embedded+talker.code_predictor.model.codec_embedding[index](codes[:,index+1])
        next_output=talker.model(inputs_embeds=pad+embedded.unsqueeze(1),position_ids=torch.full((3,1,1),size),attention_mask=torch.ones(1,size+1,dtype=torch.long),past_key_values=initial.past_key_values,use_cache=True,return_dict=True)
        logits=talker.codec_head(next_output.last_hidden_state).reshape(-1)
        assert torch.isfinite(logits).all()
        filename="step-logits-"+fixture["speaker"]+".f32"
        logits.numpy().tofile(root/filename)
        records.append(dict(speaker=fixture["speaker"],file=filename,top1=int(logits.argmax()),source="official FP32 model with official FP32 prefill cache and pad plus residual embeddings"))
(root/"step-fixtures.json").write_text(json.dumps(records,indent=2),encoding="utf-8")
print(json.dumps(records),flush=True)
