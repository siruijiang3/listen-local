"""Exercise the exact shipped engine protocol. No mocked timing or audio."""
import argparse
import base64
import json
import math
import subprocess
import time
from pathlib import Path
try:
    import psutil
except ImportError:
    psutil = None

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--python', required=True)
parser.add_argument('--model', required=True)
parser.add_argument('--device', choices=['cpu','gpu'], required=True)
parser.add_argument('--threads', type=int, default=6)
parser.add_argument('--repeats', type=int, default=20)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--measure-cuda-memory', action='store_true')
args = parser.parse_args()
args.output.parent.mkdir(parents=True, exist_ok=True)
samples = {
    'Chinese': ['雨停的时候，天还没有完全亮。', '她轻轻推开窗，看见院子里的树叶还挂着水珠。', '这是一段关于本地语音生成的测试。我们会保留原文，不改写，也不删去句子。', '“今天要去哪里？”他问。“沿着河边走走吧。”她回答。', '夜色渐深，小镇慢慢安静下来。远处的灯还亮着，像有人在等待归家的旅人。'],
    'English': ['The rain stopped before sunrise.', 'She opened the window and listened to the quiet garden.', 'This is a local audiobook test. Every sentence should be preserved, including the ending.', '“Where shall we go today?” he asked. “Let us walk along the river,” she replied.', 'Night settled over the little town. A light in the distance was still shining, waiting for someone to come home.'],
}
log = args.output.with_suffix('.log').open('w', encoding='utf-8')
worker_command = [args.python, '-u', str(ROOT / 'desktop/backend/engine_worker.py')]
if args.measure_cuda_memory:
    wrapper = '''import atexit,json,pathlib,runpy,sys,torch
def save():
    pathlib.Path(sys.argv[2]).write_text(json.dumps({'maxAllocated':torch.cuda.max_memory_allocated(),'maxReserved':torch.cuda.max_memory_reserved()},indent=2))
atexit.register(save)
runpy.run_path(sys.argv[1],run_name='__main__')
'''
    worker_command = [args.python, '-u', '-c', wrapper, str(ROOT / 'desktop/backend/engine_worker.py'), str(args.output.with_suffix('.cuda.json'))]
process = subprocess.Popen(worker_command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=log, text=True, encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))

def command(data):
    process.stdin.write(json.dumps({'protocol': 1, **data}, ensure_ascii=False)+'\n')
    process.stdin.flush()
    while True:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError('Worker exited: '+str(process.poll()))
        message = json.loads(line)
        if message['type'] == 'error':
            raise RuntimeError(message['message'])
        yield message
        if message['type'] in ('ready','done'):
            return

records = []
try:
    ready = list(command({'command':'prepare','model':str(Path(args.model).resolve()),'device':args.device,'threads':args.threads}))[-1]
    print(json.dumps(ready), flush=True)
    for voice in ('Serena','Uncle_Fu','Aiden'):
        language = 'English' if voice == 'Aiden' else 'Chinese'
        for index in range(args.repeats):
            started = time.perf_counter()
            first, total = None, 0
            audio_file = args.output.parent / f'{args.device}-{voice}-{index}.pcm'
            with audio_file.open('wb') as output:
                for message in command({'command':'generate','text':samples[language][index % 5], 'speaker':voice,'language':language,'seed':42+index}):
                    if message['type']=='audio':
                        first = first if first is not None else time.perf_counter()-started
                        pcm = base64.b64decode(message['pcm'], validate=True)
                        assert len(pcm) == message['samples']*2
                        output.write(pcm)
                        total += message['samples']
                    if message['type']=='done':
                        records.append({'speaker':voice,'firstBlock':first,'audioSeconds':total/24000,'generationSeconds':message['seconds'],'rtf':message['rtf'],'text':samples[language][index % 5]})
            memory = psutil.Process(process.pid).memory_info()._asdict() if psutil else None
            args.output.write_text(json.dumps({'ready':ready,'records':records,'threads':args.threads,'processMemory':memory}, ensure_ascii=False, indent=2), encoding='utf-8')
            print(f'{voice} {index+1}/{args.repeats}: first={first:.3f}, rtf={records[-1]["rtf"]:.3f}', flush=True)
finally:
    try:
        process.stdin.write(json.dumps({'protocol':1,'command':'quit'})+'\n')
        process.stdin.flush()
        process.wait(timeout=10)
    except Exception:
        process.kill()
    log.close()
