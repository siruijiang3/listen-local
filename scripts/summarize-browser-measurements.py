"""Summarize an exported audition record without generating or playing audio."""
import argparse
import json
import math
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("input", type=Path)
parser.add_argument("--last", type=int, help="Only the final N unique completed requests")
parser.add_argument("--output", type=Path)
args = parser.parse_args()
data = json.loads(args.input.read_text(encoding="utf-8"))
runs = {r["runId"]: r for r in data.get("runs", [])}
current = data.get("current", {})
if current.get("runId"):
    runs[current["runId"]] = current
complete = [r for r in runs.values() if r.get("completion") == "done"]
if args.last:
    complete = complete[-args.last:]

def describe(values):
    finite = sorted(v for v in values if isinstance(v, (int, float)) and math.isfinite(v))
    if not finite:
        return None
    return {"n": len(finite), "min": finite[0], "max": finite[-1],
            "p50": finite[max(0, math.ceil(len(finite) * .5) - 1)],
            "p95": finite[max(0, math.ceil(len(finite) * .95) - 1)]}

summary = {"source": str(args.input), "percentileMethod": "nearest rank",
           "uniqueRuns": len(runs), "completedRequestsIncluded": len(complete), "voices": []}
for speaker in ("Serena", "Uncle_Fu", "Aiden"):
    selected = [r for r in complete if r["request"]["speaker"] == speaker]
    if not selected:
        continue
    item = {"speaker": speaker, "requests": len(selected),
            "totalStalls": sum(r["stalls"] for r in selected),
            "frames": sorted({r["request"]["frames"] for r in selected})}
    for key in ("firstBlockSeconds", "firstPlayableSeconds", "firstOutputSeconds",
                "startToOutputSeconds", "setupSeconds", "rtf", "maxGap"):
        item[key] = describe([r.get(key) for r in selected])
    summary["voices"].append(item)
summary["otherRuns"] = [{"runId": r["runId"], "completion": r.get("completion"),
                        "received": r.get("received"), "soakSeconds": r.get("soakSeconds")}
                       for r in runs.values() if r.get("completion") != "done"]
result = json.dumps(summary, indent=2)
if args.output:
    args.output.write_text(result, encoding="utf-8")
print(result)
