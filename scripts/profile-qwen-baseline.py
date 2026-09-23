"""Read-only inference diagnostic using installed Qwen and already cached weights.

cProfile adds overhead; these timings are not a new speed benchmark.
No audition files or installed package code are modified.
"""
import cProfile
import json
import os
import pstats
import time
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
import torch
from qwen_tts import Qwen3TTSModel

torch.set_num_threads(6)
meta = json.loads(Path('.qa/qwen-model-0.6b.json').read_text(encoding='utf-8'))
model = Qwen3TTSModel.from_pretrained(meta['localPath'], device_map='cuda:0', dtype=torch.bfloat16, attn_implementation='sdpa')
def generate(text):
    torch.manual_seed(42)
    with torch.inference_mode():
        return model.generate_custom_voice(text=text, language='Chinese', speaker='Serena', instruct='', non_streaming_mode=True, max_new_tokens=4096)
generate('清晨，书店开门了。')
torch.cuda.synchronize()
phases = {}
def timed(original, name):
    def wrapper(*args, **kwargs):
        torch.cuda.synchronize()
        start = time.perf_counter()
        output = original(*args, **kwargs)
        torch.cuda.synchronize()
        phases[name] = time.perf_counter() - start
        return output
    return wrapper
model.model.generate = timed(model.model.generate, 'codecGenerationSeconds')
model.model.speech_tokenizer.decode = timed(model.model.speech_tokenizer.decode, 'waveformDecodeSeconds')
profiler = cProfile.Profile()
profiler.enable()
start = time.perf_counter()
waves, rate = generate('雨停的时候，天还没有完全亮。')
torch.cuda.synchronize()
elapsed = time.perf_counter() - start
profiler.disable()
profiler.dump_stats('.qa/qwen-baseline-profile.pstats')
stats = pstats.Stats(profiler)
rows=[]
for (file,line,name),(primitive,total,self_time,cumulative,callers) in stats.stats.items():
    rows.append({'function':name,'file':file,'line':line,'calls':total,'selfSeconds':self_time,'cumulativeSeconds':cumulative})
result={'model':meta['repo'],'revision':meta['revision'],'note':'cProfile diagnostic; timing includes profiling overhead, not a benchmark','totalSeconds':elapsed,'audioSeconds':len(waves[0])/rate,'phases':phases,'topSelf':sorted(rows,key=lambda r:r['selfSeconds'],reverse=True)[:30],'topCumulative':sorted(rows,key=lambda r:r['cumulativeSeconds'],reverse=True)[:40]}
Path('.qa/qwen-baseline-profile.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in result.items() if k not in ['topSelf','topCumulative']},ensure_ascii=False),flush=True)
stats.strip_dirs().sort_stats('tottime').print_stats(18)
