"""Package the verified audition bundle for playback outside the in-app browser."""
import argparse
import json
import runpy
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

parser = argparse.ArgumentParser()
parser.add_argument("--size", choices=["1.7B", "0.6B"], default="1.7B")
args = parser.parse_args()
runpy.run_path("scripts/verify-qwen-auditions.py")
root = Path("public/auditions/qwen3" if args.size == "1.7B" else "public/auditions/qwen3-0.6b")
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
output = root / "qwen3-auditions.zip"
with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=1) as bundle:
    bundle.write(root / "manifest.json", "manifest.json")
    bundle.writestr("README.txt", (
        f"Qwen3-TTS {args.size} CustomVoice audition / 官方原版试听\n\n"
        "中文：Serena、Uncle_Fu；英文：Aiden。每种声音五段短文和一段长文。\n"
        "使用本机官方 Python 实现预生成；所有声音均待人工审核。\n"
        "用系统播放器打开 WAV；同名 TXT 是对应原文，不是语音识别转写。\n"
        "manifest.json 保留权重版本、原文分段、生成用时与文件校验值。\n"
        "长文按原始段落生成后拼接。无调速、无音高处理。\n"
        "页面的个人评价未包含在此包内，可从页面单独导出。\n"
        "官方来源：https://github.com/QwenLM/Qwen3-TTS\n"
    ).encode("utf-8-sig"))
    for clip in manifest["clips"]:
        bundle.write(root / clip["file"], clip["file"])
        bundle.writestr(Path(clip["file"]).with_suffix(".txt").name,
                        clip["text"].encode("utf-8-sig"))
print(f"Packaged {len(manifest['clips'])} auditions: {output} ({output.stat().st_size:,} bytes)")
