"""Reproduce summaries from browser-exported measurement files (no inference)."""
import json
import math
from pathlib import Path

root = Path(".qa/realtime")
def read(name):
    return json.loads((root/name).read_text(encoding="utf-8"))
def percentile(values, q):
    return sorted(values)[max(0, math.ceil(len(values)*q)-1)]

short = read("chrome-short-60.json")["runs"][-60:]
result = {"percentileMethod": "nearest rank", "short": [], "frames": []}
for voice in ["Serena", "Uncle_Fu", "Aiden"]:
    runs = [r for r in short if r["request"]["speaker"] == voice]
    item = {"speaker": voice, "requests": len(runs), "stalls": sum(r["stalls"] for r in runs)}
    for key in ["firstBlockSeconds", "firstPlayableSeconds", "firstOutputSeconds", "rtf"]:
        values = [r[key] for r in runs]
        item[key] = {"p50": percentile(values,.5), "p95": percentile(values,.95), "max": max(values)}
    result["short"].append(item)
for r in read("chrome-frames.json")["runs"]:
    result["frames"].append({"speaker": r["request"]["speaker"], "frames": r["request"]["frames"],
        **{k: r[k] for k in ["firstPlayableSeconds", "firstOutputSeconds", "rtf", "received", "stalls"]}})
soak = read("chrome-soak.json")["runs"][0]
trace = [t for t in soak["trace"] if t["played"] > 0 and t["seconds"] <= 1800]
result["soak"] = {k: soak[k] for k in ["soakSeconds", "received", "rtf", "stalls", "maxGap", "generationSeconds", "backpressureSeconds"]}
for k in ["buffer", "rssBytes", "gpuAllocatedBytes", "gpuReservedBytes"]:
    values = [t[k] for t in trace if k in t]
    result["soak"][k] = {"min": min(values), "max": max(values), "first": values[0], "last": values[-1]}
if (root/"chrome-long.json").exists():
    data = read("chrome-long.json")
    result["long"] = []
    for r in data["runs"]:
        if r.get("soakSeconds"): continue
        if r["runId"] == data["current"]["runId"]: r = data["current"]
        # Older build took completion snapshots before the last buffered audio
        # played. The shared per-second trace still records actual output.
        result["long"].append({"speaker": r["request"]["speaker"],
            **{k: r.get(k) for k in ["received", "rtf", "stalls", "maxGap", "completion"]},
            "played": max([r["played"]]+[t["played"] for t in r.get("trace",[])])})
(root/"summary.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result, indent=2))
