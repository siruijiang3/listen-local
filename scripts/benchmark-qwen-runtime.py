"""Native original-weight measurements; no changes to accepted audition files."""
import argparse
import json
import os
import subprocess
import threading
import time
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
import torch
from qwen_tts import Qwen3TTSModel

parser = argparse.ArgumentParser()
parser.add_argument('--size', choices=['0.6B', '1.7B'], required=True)
args = parser.parse_args()
meta = json.loads(Path('.qa/qwen-model-0.6b.json' if args.size == '0.6B' else '.qa/qwen-model.json').read_text(encoding='utf-8'))
samples = json.loads(Path('.qa/qwen-inputs.json').read_text(encoding='utf-8'))
torch.set_num_threads(6)

def gpu():
    fields = subprocess.check_output(['nvidia-smi', '--query-gpu=memory.used,power.draw,clocks.sm', '--format=csv,noheader,nounits'], text=True, creationflags=subprocess.CREATE_NO_WINDOW).strip().splitlines()[0].split(',')
    return dict(zip(['usedMiB', 'powerW', 'clockMHz'], [float(x.strip()) for x in fields]))

baseline = gpu()
tick = time.perf_counter()
model = Qwen3TTSModel.from_pretrained(meta['localPath'], device_map='cuda:0', dtype=torch.bfloat16, attn_implementation='sdpa')
torch.cuda.synchronize()
result = {'size': args.size, 'revision': meta['revision'], 'device': torch.cuda.get_device_name(0), 'baselineGpu': baseline, 'loadSeconds': time.perf_counter()-tick, 'loadedGpu': gpu(), 'loadedAllocatedGiB': torch.cuda.memory_allocated()/2**30, 'runs': []}

def generate(text, language, speaker):
    torch.manual_seed(42)
    with torch.inference_mode():
        return model.generate_custom_voice(text=text, language=language, speaker=speaker, instruct='', non_streaming_mode=True, max_new_tokens=4096)

generate('清晨，书店开门了。', 'Chinese', 'Serena')
torch.cuda.synchronize()
cases = [('zh-opening', '雨停的时候，天还没有完全亮。', 'Chinese', 'Serena')]
for key, language, voice in [('zh-story','Chinese','Serena'),('en-story','English','Aiden')]:
    cases.append((key, next(s['text'] for s in samples if s['id']==key), language, voice))
for name, text, language, voice in cases:
    observations=[]
    stop=threading.Event()
    def sample_gpu():
        while not stop.is_set():
            observations.append(gpu())
            stop.wait(1)
    monitor=threading.Thread(target=sample_gpu, daemon=True)
    monitor.start()
    torch.cuda.reset_peak_memory_stats()
    torch.cuda.synchronize()
    tick=time.perf_counter()
    wavs, rate=generate(text,language,voice)
    torch.cuda.synchronize()
    elapsed=time.perf_counter()-tick
    stop.set()
    monitor.join()
    seconds=len(wavs[0])/rate
    run={'case':name,'text':text,'voice':voice,'generationSeconds':elapsed,'audioSeconds':seconds,'rtf':elapsed/seconds,'peakAllocatedGiB':torch.cuda.max_memory_allocated()/2**30,'peakReservedGiB':torch.cuda.max_memory_reserved()/2**30,'gpuSamples':observations,'sampledWholeGpuPeakMiB':max(x['usedMiB'] for x in observations)}
    result['runs'].append(run)
    Path(f'.qa/qwen-benchmark-{args.size}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in run.items() if k not in ['text','gpuSamples']}) ,flush=True)
print('BENCHMARK_DONE '+args.size,flush=True)
