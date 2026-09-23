"""Loopback-only BF16 Qwen streaming service. Run from the repository root.

One CUDA thread owns the model, graphs, generators and teardown. WebSocket
control stays responsive while CUDA is busy. No files or model IDs from clients.
"""
import asyncio
import concurrent.futures
import gc
import json
import os
from pathlib import Path
import struct
import threading
import time
import traceback

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HOME"] = str(Path(".qa/hf-cache").resolve())
import numpy as np
import psutil
import torch
from faster_qwen3_tts import FasterQwen3TTS
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

ORIGINS = [f"http://{host}:{port}" for host in ("127.0.0.1", "localhost") for port in (4173, 5173)]
POOL = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="qwen-cuda")
MODEL = None
MODEL_INFO = {}
OWNER = None
META = json.loads(Path(".qa/qwen-model-0.6b.json").read_text(encoding="utf-8"))
torch.set_num_threads(6)


def memory():
    return dict(rssBytes=psutil.Process().memory_info().rss,
                gpuAllocatedBytes=torch.cuda.memory_allocated(),
                gpuReservedBytes=torch.cuda.memory_reserved(),
                gpuPeakBytes=torch.cuda.max_memory_allocated())


def prepare(emit):
    global MODEL, MODEL_INFO
    if MODEL is not None and MODEL_INFO:
        emit(dict(type="ready", cached=True, **MODEL_INFO, **memory()))
        return
    if MODEL is not None:
        release()
    started = time.perf_counter()
    emit(dict(type="status", phase="loading", message="加载本机已缓存的官方 BF16 权重"))
    MODEL = FasterQwen3TTS.from_pretrained(META["localPath"], device="cuda:0", dtype=torch.bfloat16,
                                         attn_implementation="sdpa", max_seq_len=2048)
    loaded = time.perf_counter()
    emit(dict(type="status", phase="warming", message="捕获 CUDA 图并预热音频解码器"))
    MODEL.warmup(prefill_len=100)
    # Exercise the codec as well as the graph; this is explicitly not an audition.
    list(MODEL.generate_custom_voice_streaming(text="你好。", speaker="Serena", language="Chinese",
                                               chunk_size=8, max_new_tokens=8))
    torch.cuda.synchronize()
    MODEL_INFO = dict(model=META["repo"], revision=META["revision"], modelBytes=META["totalFileBytes"],
              loadSeconds=loaded-started, warmupSeconds=time.perf_counter()-loaded,
              device=torch.cuda.get_device_name(), dtype="bfloat16")
    emit(dict(type="ready", **MODEL_INFO, **memory()))


class Job:
    def __init__(self, request):
        self.request = request
        self.cancel = threading.Event()
        self.condition = threading.Condition()
        self.played = 0.0
        self.generated = 0.0
        self.last_flow = time.monotonic()

    def flow(self, played):
        with self.condition:
            self.played = max(self.played, min(float(played), self.generated))
            self.last_flow = time.monotonic()
            self.condition.notify_all()

    def stop(self):
        self.cancel.set()
        with self.condition:
            self.condition.notify_all()

    def wait_credit(self):
        tick = time.perf_counter()
        with self.condition:
            while self.generated-self.played >= 29 and not self.cancel.is_set():
                # A paused/background tab may throttle JS timers. The socket's
                # own ping/pong detects disconnects; silence is not cancellation.
                self.condition.wait(0.25)
        return time.perf_counter()-tick


def generate(job, emit, binary):
    request = job.request
    started = time.perf_counter()
    waiting = 0.0
    first = None
    sequence = 0
    torch.cuda.reset_peak_memory_stats()
    for part, text in enumerate(request["segments"]):
        if job.cancel.is_set():
            break
        torch.manual_seed(42+part)
        stream = MODEL.generate_custom_voice_streaming(
            text=text, speaker=request["speaker"], language=request["language"], instruct="",
            non_streaming_mode=True, chunk_size=request["frames"], max_new_tokens=1800,
            temperature=0.9, top_k=50, top_p=1.0, do_sample=True, repetition_penalty=1.05)
        # Pull only while the bounded playback queue has capacity. Closing drops
        # decoder/context tensors immediately on cancellation, on the CUDA thread.
        try:
            last_steps = 0
            while not job.cancel.is_set():
                waiting += job.wait_credit()
                if job.cancel.is_set():
                    break
                try:
                    pcm, rate, timing = next(stream)
                except StopIteration:
                    break
                if job.cancel.is_set():
                    break
                pcm = np.asarray(pcm, dtype="<f4").reshape(-1)
                last_steps = timing.get("total_steps_so_far", 0)
                if not len(pcm):
                    continue
                if not np.isfinite(pcm).all():
                    raise RuntimeError("模型输出非有限 PCM")
                first = first if first is not None else time.perf_counter()-started
                job.generated += len(pcm)/rate
                active_seconds = time.perf_counter()-started-waiting
                header = json.dumps(dict(type="audio", runId=request["runId"], seq=sequence,
                    part=part, sampleRate=rate, samples=len(pcm), generatedSeconds=job.generated,
                    elapsedSeconds=time.perf_counter()-started, generationSeconds=active_seconds,
                    backpressureSeconds=waiting, rtf=active_seconds/job.generated, **memory())).encode()
                binary(struct.pack("<I", len(header))+header+pcm.tobytes())
                sequence += 1
        finally:
            stream.close()
        if last_steps >= 1799 and not job.cancel.is_set():
            raise RuntimeError("片段达到生成上限，可能截断。请缩短输入片段后重试；本次不标为完成。")
        if not job.cancel.is_set():
            emit(dict(type="part", part=part, text=text))
    torch.cuda.synchronize()
    elapsed = time.perf_counter()-started
    emit(dict(type="cancelled" if job.cancel.is_set() else "done", chunks=sequence,
        generationSeconds=elapsed-waiting, wallSeconds=elapsed, backpressureSeconds=waiting,
        audioSeconds=job.generated, firstBlockSeconds=first,
        rtf=(elapsed-waiting)/job.generated if job.generated else None, **memory()))


def release():
    global MODEL, MODEL_INFO
    MODEL = None
    MODEL_INFO = {}
    gc.collect()
    torch.cuda.empty_cache()


def validate(msg):
    if not isinstance(msg.get("runId"), str) or not 1 <= len(msg["runId"]) <= 100:
        raise ValueError("Invalid runId")
    if msg.get("speaker") not in ("Serena", "Uncle_Fu", "Aiden"):
        raise ValueError("Unsupported voice")
    if msg.get("language") not in ("Chinese", "English") or ((msg["speaker"] == "Aiden") != (msg["language"] == "English")):
        raise ValueError("Voice/language mismatch")
    if msg.get("frames") not in (4, 8, 12):
        raise ValueError("Use 4/8/12 frames")
    parts = msg.get("segments")
    if not isinstance(parts, list) or not parts or len(parts) > 10000:
        raise ValueError("Invalid text segments")
    if any(not isinstance(p, str) or not p.strip() or len(p) > 1600 for p in parts):
        raise ValueError("Invalid segment length")


async def connection(ws):
    global OWNER
    loop = asyncio.get_running_loop()
    send_lock = asyncio.Lock()
    job = None
    running = None

    async def send(payload):
        async with send_lock:
            await ws.send(payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False))

    def dispatch(payload):
        asyncio.run_coroutine_threadsafe(send(payload), loop).result(timeout=10)

    async def operation(fn, *args, run_id=None):
        try:
            await loop.run_in_executor(POOL, fn, *args)
        except ConnectionClosed:
            # A closed browser is cancellation, not a service ownership leak.
            pass
        except Exception as error:
            traceback.print_exc()
            try:
                await send(dict(type="error", runId=run_id, message=str(error)))
            except ConnectionClosed:
                pass

    async def drain():
        nonlocal job, running
        if job:
            job.stop()
        if running:
            await running
        running = None
        job = None

    try:
        await send(dict(type="hello", protocol=1, engine="faster-qwen3-tts-0.4.0", **META))
        async for raw in ws:
            try:
                msg = json.loads(raw)
                action = msg.get("type")
                if OWNER is not None and OWNER is not ws:
                    await send(dict(type="error", message="另一页面正在使用模型，请先在该页面释放模型"))
                    continue
                if action == "prepare":
                    OWNER = ws
                    await drain()
                    running = asyncio.create_task(operation(prepare, dispatch))
                elif action == "start":
                    validate(msg)
                    await drain()
                    if MODEL is None:
                        raise ValueError("请先准备模型")
                    OWNER = ws
                    job = Job(msg)
                    def emit(data, run_id=msg["runId"]):
                        dispatch(dict(data, runId=run_id))
                    running = asyncio.create_task(operation(generate, job, emit, dispatch, run_id=msg["runId"]))
                elif action == "flow" and job and msg.get("runId") == job.request["runId"]:
                    job.flow(msg.get("playedSeconds", 0))
                elif action == "cancel":
                    await drain()
                elif action == "release":
                    await drain()
                    await operation(release)
                    OWNER = None
                    await send(dict(type="released"))
            except (ValueError, TypeError, KeyError) as error:
                await send(dict(type="error", message=str(error)))
    finally:
        try:
            await drain()
        finally:
            if OWNER is ws:
                await loop.run_in_executor(POOL, release)
                OWNER = None


async def main():
    # The listening-ready announcement means the initial load, graph capture and
    # codec warmup have all finished. Later page-driven prepare is a cache hit.
    await asyncio.get_running_loop().run_in_executor(POOL, prepare,
        lambda event: print(json.dumps(event, ensure_ascii=False), flush=True))
    async with serve(connection, "127.0.0.1", 8765, origins=ORIGINS, max_size=2**20,
                     max_queue=8, compression=None, ping_interval=10, ping_timeout=20):
        print("QWEN_REALTIME ws://127.0.0.1:8765 origins="+str(ORIGINS), flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
