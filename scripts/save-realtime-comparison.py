"""Save streaming 4/8/12-frame clips for human review, outside latency tests."""
import asyncio
import json
from pathlib import Path
import struct
import numpy as np
import soundfile as sf
from websockets.asyncio.client import connect

async def main():
    originals=json.loads(Path("public/auditions/qwen3-0.6b/manifest.json").read_text(encoding="utf-8"))["clips"]
    target=Path("public/auditions/qwen-realtime"); target.mkdir(exist_ok=True)
    clips=[]
    async with connect("ws://127.0.0.1:8765", origin="http://localhost:4173", max_size=2**20) as ws:
        await ws.send(json.dumps(dict(type="prepare")))
        while True:
            data=json.loads(await ws.recv())
            if data["type"]=="error":raise RuntimeError(data)
            if data["type"]=="ready":break
        for original in [c for c in originals if c["sampleId"] in ("zh-story","en-story")]:
            for frames in (4,8,12):
                run=f"review-{original['speaker']}-{frames}"
                await ws.send(json.dumps(dict(type="start", runId=run, speaker=original["speaker"],
                    language="Chinese" if original["language"]=="zh" else "English", frames=frames,
                    segments=[original["text"]]),ensure_ascii=False))
                chunks=[]
                while True:
                    raw=await ws.recv()
                    if isinstance(raw,bytes):
                        n=struct.unpack("<I",raw[:4])[0]; header=json.loads(raw[4:4+n])
                        assert header["runId"]==run and header["seq"]==len(chunks)
                        chunks.append(np.frombuffer(raw[4+n:],dtype="<f4"))
                        await ws.send(json.dumps(dict(type="flow",runId=run,playedSeconds=header["generatedSeconds"])))
                    else:
                        data=json.loads(raw)
                        if data["type"]=="error":raise RuntimeError(data)
                        if data["type"]=="done":break
                pcm=np.concatenate(chunks)
                sf.write(target/(run+"-raw.wav"),pcm,24000)
                # Same active-RMS/peak rule as original auditions. This copy is
                # for listening only and never participates in first-audio timing.
                active=pcm[np.abs(pcm)>0.005]
                rms=float(np.sqrt(np.mean(active**2))) if len(active) else 0
                gain=min(.1/max(rms,1e-8),.94/max(float(np.max(np.abs(pcm))),1e-8),8.)
                sf.write(target/(run+".wav"),pcm*gain,24000)
                clips.append(dict(speaker=original["speaker"],frames=frames,text=original["text"],
                    file=run+".wav",rawFile=run+"-raw.wav",gainDb=float(20*np.log10(gain)),
                    original="/auditions/qwen3-0.6b/"+original["file"],seconds=len(pcm)/24000,
                    metrics=data,quality="awaiting-human-review"))
                print(run, data["rtf"], flush=True)
                (target/"manifest.json").write_text(json.dumps(dict(clips=clips),ensure_ascii=False,indent=2),encoding="utf-8")
        await ws.send(json.dumps(dict(type="release")))
        while json.loads(await ws.recv())["type"]!="released":pass

asyncio.run(main())
