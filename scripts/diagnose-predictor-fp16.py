"""Find the first non-finite layer using official weights and a saved real input."""
import os
os.environ["HF_HUB_OFFLINE"]="1"
os.environ["TRANSFORMERS_OFFLINE"]="1"
import numpy as np
import torch
from qwen_tts import Qwen3TTSModel
torch.set_num_threads(4)
m=Qwen3TTSModel.from_pretrained(".qa/models/qwen3-0.6b-customvoice",device_map="cpu",dtype=torch.float16,attn_implementation="eager")
class Found(Exception):pass
def hook(name):
    def inspect(module,args,output):
        value=output[0] if isinstance(output,tuple) else output
        if isinstance(value,torch.Tensor) and value.is_floating_point() and not torch.isfinite(value).all():
            print("FIRST_NONFINITE",name,tuple(value.shape),"finite",int(torch.isfinite(value).sum()),flush=True)
            for i,x in enumerate(args):
                if isinstance(x,torch.Tensor):print("INPUT",i,tuple(x.shape),str(x.dtype),bool(torch.isfinite(x).all()),float(x.abs().max()),flush=True)
            raise Found()
    return inspect
for name,module in m.model.talker.code_predictor.named_modules():module.register_forward_hook(hook(name))
h=torch.from_numpy(np.fromfile("public/models/qwen-webgpu/hidden-Serena.f16",dtype=np.float16).reshape(1,1024))
codes=torch.zeros(1,16,dtype=torch.int64);codes[0,0]=1995
try:
    with torch.inference_mode():m.model.talker.forward_sub_talker_finetune(codes,h)
except Found:pass
