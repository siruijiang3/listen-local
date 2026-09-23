"""Wire-level smoke test, not a browser playback or acoustic measurement."""
import asyncio
import json
from pathlib import Path
import struct
import time
from websockets.asyncio.client import connect
import numpy as np
import soundfile as sf

async def main():
    async with connect("ws://127.0.0.1:8765", origin="http://127.0.0.1:4173", max_size=2**22, ping_timeout=120) as ws:
        await ws.send(json.dumps({"type":"prepare"}))
        while True:
            data=json.loads(await ws.recv()); print(data,flush=True)
            if data["type"]=="error":return
            if data["type"]=="ready":break
        request=dict(type="start",runId="smoke",speaker="Serena",language="Chinese",frames=8,
                     segments=["雨停的时候，天还没有完全亮。林安推开书店的木门，闻到纸张和潮湿木头混在一起的气味。"])
        await ws.send(json.dumps(request))
        audio=[]; start=time.perf_counter()
        while True:
            raw=await ws.recv()
            if isinstance(raw,bytes):
                size=struct.unpack("<I",raw[:4])[0];header=json.loads(raw[4:4+size]); pcm=np.frombuffer(raw[4+size:],dtype="<f4");audio.append(pcm)
                if len(audio)==1:print("FIRST_BLOCK",time.perf_counter()-start,flush=True)
                await ws.send(json.dumps(dict(type="flow",runId="smoke",playedSeconds=header["generatedSeconds"])))
            else:
                data=json.loads(raw);print(data,flush=True)
                if data["type"]=="done":
                    out=Path(".qa/realtime");out.mkdir(exist_ok=True)
                    sf.write(out/"native-smoke.wav",np.concatenate(audio),24000)
                    (out/"native-smoke.json").write_text(json.dumps(data,indent=2),encoding="utf-8");break
                if data["type"]=="error":break
        await ws.send(json.dumps(dict(type="release")))

asyncio.run(main())
