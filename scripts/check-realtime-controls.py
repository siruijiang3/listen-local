"""Loopback protocol acceptance: bounded pause, resume, cancel/restart, disconnect.

Run only when the browser has released its model. This uses synthetic public text,
the installed local model, and never sends anything to an external service.
"""
import asyncio
import json
from pathlib import Path
import struct
import time
from websockets.asyncio.client import connect

URI = "ws://127.0.0.1:8765"
ORIGIN = "http://localhost:4173"
records = {}


async def event(ws, timeout=60):
    raw = await asyncio.wait_for(ws.recv(), timeout)
    if isinstance(raw, bytes):
        n = struct.unpack("<I", raw[:4])[0]
        header = json.loads(raw[4:4+n])
        assert len(raw)-4-n == header["samples"]*4
        return header
    value = json.loads(raw)
    assert value["type"] != "error", value
    return value


async def prepared(ws):
    await ws.send(json.dumps({"type": "prepare"}))
    while True:
        data = await event(ws)
        if data["type"] == "ready":
            return data


async def send(ws, value):
    await ws.send(json.dumps(value, ensure_ascii=False))


def request(run, text):
    return dict(type="start", runId=run, speaker="Serena", language="Chinese",
                frames=8, segments=[text])


async def main():
    async with connect(URI, origin=ORIGIN, max_size=2**20) as ws:
        records["ready"] = await prepared(ws)
        text = "清晨六点，林安推开了书店的门。昨夜的雨已经停了。街道很安静，只有早点铺的蒸汽从拐角升起。"*4
        await send(ws, request("pause", text))
        count = 0
        duration = 0
        while duration < 29:
            data = await event(ws)
            if data["type"] == "audio":
                assert data["seq"] == count
                count += 1
                duration += data["samples"]/24000
        try:
            unexpected = await event(ws, timeout=3)
            raise AssertionError(f"Producer did not pause: {unexpected}")
        except asyncio.TimeoutError:
            pass
        assert 29 <= duration < 30.1
        records["pause"] = dict(bufferSeconds=duration, noAudioForSeconds=3)
        tick = time.perf_counter()
        await send(ws, dict(type="flow", runId="pause", playedSeconds=duration-2))
        data = await event(ws)
        assert data["type"] == "audio" and data["seq"] == count
        records["resume"] = dict(nextBlockSeconds=time.perf_counter()-tick, sequence=data["seq"])
        await send(ws, dict(type="cancel"))
        await send(ws, request("restart", "你好，这是取消后立即重新开始的测试。"))
        first = None
        count = 0
        saw_new = False
        while True:
            data = await event(ws)
            if data.get("runId") == "restart":
                saw_new = True
                if data["type"] == "audio":
                    assert data["seq"] == count
                    count += 1
                    first = first or data
                if data["type"] == "done":
                    break
            elif saw_new:
                raise AssertionError("Old run arrived after new run began")
        assert first and count > 0
        records["cancelRestart"] = dict(chunks=count, oldPacketsAfterNewRun=0)
        await send(ws, request("disconnect", text))
        while (await event(ws))["type"] != "audio":
            pass
    # A fresh page must be able to reclaim the service after an active disconnect.
    await asyncio.sleep(1)
    async with connect(URI, origin=ORIGIN, max_size=2**20) as ws:
        records["disconnectReprepare"] = await prepared(ws)
        await send(ws, dict(type="release"))
        while (await event(ws))["type"] != "released":
            pass
    records["passed"] = True
    Path(".qa/realtime/control-checks.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    print(json.dumps(records), flush=True)


asyncio.run(main())
