"""Capture the official CustomVoice frontend before generation, without changing it."""
import json
import os
from pathlib import Path
os.environ["HF_HUB_OFFLINE"]="1"
os.environ["TRANSFORMERS_OFFLINE"]="1"
import torch
from qwen_tts import Qwen3TTSModel
torch.set_num_threads(4)
root=Path("public/models/qwen-webgpu")
model=Qwen3TTSModel.from_pretrained(".qa/models/qwen3-0.6b-customvoice",device_map="cpu",dtype=torch.float32,attn_implementation="eager")
fixtures=[]
class Captured(Exception):pass
captured={}
def capture(**kwargs):
    captured.update(kwargs)
    raise Captured()
model.model.talker.generate=capture
for speaker,language,text in [("Serena","Chinese","雨停的时候，天还没有完全亮。"),("Uncle_Fu","Chinese","林安推开书店的木门。"),("Aiden","English","The rain stopped before sunrise.")]:
    captured.clear()
    with torch.inference_mode():
        try:model.generate_custom_voice(text=text,speaker=speaker,language=language,instruct="",non_streaming_mode=True)
        except Captured:pass
        x=captured["inputs_embeds"]
        size=x.shape[1]
        pos=torch.arange(size).view(1,1,size).expand(3,1,size).contiguous()
        hidden=model.model.talker.model(inputs_embeds=x,position_ids=pos,attention_mask=captured["attention_mask"],use_cache=False,return_dict=True).last_hidden_state
        logits=model.model.talker.codec_head(hidden)[:,-1,:]
        codes=torch.zeros((1,16),dtype=torch.int64)
        codes[0,0]=logits[:,:2048].argmax()
        predictor,_=model.model.talker.forward_sub_talker_finetune(codes,hidden[:,-1,:])
    input_file=f"prefill-{speaker}.f16";logits_file=f"logits-{speaker}.f16"
    for value in (x,logits,hidden,predictor): assert torch.isfinite(value).all(), "Invalid official reference"
    x.to(torch.float16).cpu().numpy().tofile(root/input_file);logits.to(torch.float16).cpu().numpy().tofile(root/logits_file)
    hidden_file=f"hidden-{speaker}.f16";predictor_file=f"predictor-{speaker}.f32"
    hidden[:,-1,:].to(torch.float16).cpu().numpy().tofile(root/hidden_file);predictor.cpu().numpy().tofile(root/predictor_file)
    fixtures.append(dict(speaker=speaker,language=language,text=text,input=input_file,logits=logits_file,shape=list(x.shape),top1=int(logits.argmax()),hidden=hidden_file,predictor=predictor_file,codes=codes[0].tolist(),referenceDtype="official FP32; input/hidden/logits rounded to FP16 for storage"))
(root/"prefill-fixtures.json").write_text(json.dumps(fixtures,ensure_ascii=False,indent=2),encoding="utf-8")
print(json.dumps(fixtures,ensure_ascii=False),flush=True)
