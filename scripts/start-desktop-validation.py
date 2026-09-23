"""Start an isolated developer library, without changing the user's installed app."""
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
home = ROOT / '.qa/desktop-validation/app'
home.mkdir(parents=True, exist_ok=True)
settings = {'library': str(home / 'library'), 'runtimePython': str(ROOT / '.qa/qwen-fast-env/Scripts/python.exe'),
            'model': str(ROOT / '.qa/models/qwen3-0.6b-customvoice'), 'threads': 6}
(home / 'settings.json').write_text(json.dumps(settings), encoding='utf-8')
log = (home / 'core.log').open('w', encoding='utf-8')
process = subprocess.Popen([sys.executable, '-u', str(ROOT / 'desktop/backend/host.py'), '--home', str(home)], stdout=subprocess.PIPE,
                           stderr=log, text=True, encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
connection = json.loads(process.stdout.readline())
connection['pid'] = process.pid
(home.parent / 'connection.json').write_text(json.dumps(connection), encoding='utf-8')
print(json.dumps({'port': connection['port'], 'pid': process.pid}), flush=True)
process.wait()
