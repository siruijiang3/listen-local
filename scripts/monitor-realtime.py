"""Whole-device telemetry; never confuse this with per-model allocated bytes."""
import csv
from datetime import datetime,timezone
import json
from pathlib import Path
import subprocess
import time
root=Path(".qa/realtime");root.mkdir(exist_ok=True)
stop=root/"monitor.stop"
output=root/"gpu-monitor.jsonl"
started=time.monotonic()
with output.open("a",encoding="utf-8") as file:
    while time.monotonic()-started<7200 and not stop.exists():
        result=subprocess.run(["nvidia-smi","--query-gpu=memory.used,memory.total,utilization.gpu,power.draw,temperature.gpu","--format=csv,noheader,nounits"],capture_output=True,text=True)
        row=next(csv.reader(result.stdout.splitlines()),[]) if result.returncode==0 else []
        file.write(json.dumps(dict(utc=datetime.now(timezone.utc).isoformat(),elapsed=time.monotonic()-started,
                                   columns=["wholeGpuUsedMiB","totalMiB","gpuPercent","watts","celsius"],values=row))+"\n")
        file.flush();time.sleep(1)
