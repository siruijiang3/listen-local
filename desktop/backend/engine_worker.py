"""Versioned JSON-lines worker. Only this process imports Torch/model packages."""
import base64
import contextlib
import json
import os
import sys
import time

PROTOCOL = 1
wire = sys.stdout


def emit(data):
    wire.write(json.dumps(data, ensure_ascii=False) + '\n')
    wire.flush()


def main():
    # Windows pipe defaults may use a legacy code page. The protocol is UTF-8.
    sys.stdin.reconfigure(encoding='utf-8')
    wire.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    # Upstream informational output must not corrupt the protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import torch
        model = None
        device = 'cpu'
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if request.get('protocol') != PROTOCOL:
                    raise ValueError('引擎协议版本不匹配')
                command = request['command']
                if command == 'quit':
                    return
                if command == 'prepare':
                    started = time.perf_counter()
                    os.environ['HF_HUB_OFFLINE'] = '1'
                    os.environ['TRANSFORMERS_OFFLINE'] = '1'
                    torch.set_num_threads(int(request.get('threads', 6)))
                    torch.set_num_interop_threads(1)
                    preference = request.get('device', 'auto')
                    reason = None
                    if preference != 'cpu' and torch.cuda.is_available() and torch.cuda.is_bf16_supported():
                        try:
                            from faster_qwen3_tts import FasterQwen3TTS
                            model = FasterQwen3TTS.from_pretrained(request['model'], device='cuda:0', dtype=torch.bfloat16,
                                                                  attn_implementation='sdpa', max_seq_len=2048)
                            model.warmup(prefill_len=100)
                            list(model.generate_custom_voice_streaming(text='你好。', speaker='Serena', language='Chinese', chunk_size=8, max_new_tokens=8))
                            torch.cuda.synchronize()
                            device = 'cuda'
                        except Exception as error:
                            if preference == 'gpu':
                                raise
                            reason = str(error)
                            model = None
                            import gc
                            gc.collect()
                            torch.cuda.empty_cache()
                    elif preference == 'gpu':
                        raise RuntimeError('没有可用的 NVIDIA CUDA/BF16 设备，请检查驱动或选择 CPU。')
                    elif preference == 'auto':
                        reason = 'CUDA/BF16 不可用，已使用 CPU。'
                    if model is None:
                        from qwen_tts import Qwen3TTSModel
                        model = Qwen3TTSModel.from_pretrained(request['model'], device_map='cpu', dtype=torch.float32, attn_implementation='sdpa')
                        device = 'cpu'
                    emit({'type': 'ready', 'protocol': PROTOCOL, 'device': device, 'reason': reason,
                          'streaming': device == 'cuda', 'loadSeconds': time.perf_counter()-started})
                elif command == 'generate':
                    if model is None:
                        raise RuntimeError('模型尚未准备')
                    torch.manual_seed(request['seed'])
                    kwargs = dict(text=request['text'], speaker=request['speaker'], language=request['language'], instruct='',
                                  non_streaming_mode=True, max_new_tokens=1800, temperature=0.9,
                                  top_k=50, top_p=1.0, do_sample=True, repetition_penalty=1.05)
                    started = time.perf_counter()
                    count, steps = 0, 0
                    with torch.inference_mode():
                        if device == 'cuda':
                            stream = model.generate_custom_voice_streaming(**kwargs, chunk_size=8)
                        else:
                            # Inspect returned codec length: EOS/limits cannot be inferred from a WAV.
                            base = model.model
                            ids = model._tokenize_texts([model._build_assistant_text(request['text'])])
                            generation = model._merge_generate_kwargs(**{k:v for k,v in kwargs.items() if k not in ('text','speaker','language','instruct','non_streaming_mode')})
                            codes, _ = base.generate(input_ids=ids, instruct_ids=[None], languages=[request['language']],
                                                     speakers=[request['speaker']], non_streaming_mode=True, **generation)
                            steps = len(codes[0])
                            if steps >= 1799:
                                raise RuntimeError('片段达到生成上限，未标记为完成。请缩短正文片段。')
                            waves, rate = model.model.speech_tokenizer.decode([{'audio_codes': codes[0]}])
                            stream = [(waves[0], rate, {'total_steps_so_far': steps})]
                        for audio, rate, timing in stream:
                            array = np.asarray(audio, dtype=np.float32).reshape(-1)
                            if rate != 24000 or not np.isfinite(array).all():
                                raise RuntimeError('模型返回无效音频')
                            steps = timing.get('total_steps_so_far', steps)
                            pcm = np.rint(np.clip(array, -1, 1) * np.where(array < 0, 32768, 32767)).astype('<i2')
                            count += len(pcm)
                            emit({'type': 'audio', 'samples': len(pcm), 'pcm': base64.b64encode(pcm.tobytes()).decode('ascii')})
                    if steps >= 1799 or count == 0:
                        raise RuntimeError('生成达到上限或没有音频，本段未完成。')
                    elapsed = time.perf_counter()-started
                    emit({'type': 'done', 'samples': count, 'seconds': elapsed, 'rtf': elapsed/(count/24000)})
                else:
                    raise ValueError('未知引擎命令')
            except Exception as error:
                import traceback
                traceback.print_exc(file=sys.stderr)
                emit({'type': 'error', 'message': str(error)})


if __name__ == '__main__':
    main()
