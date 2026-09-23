"""Real CPU generation interrupted through the same shutdown API as the tray."""
import argparse
import hashlib
import json
import subprocess
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
for name in ('core', 'home', 'runtime', 'model'):
    parser.add_argument('--' + name, required=True, type=Path)
args = parser.parse_args()
args.home.mkdir(parents=True, exist_ok=True)
log = (args.home / 'recovery.log').open('w', encoding='utf-8')

def start():
    process = subprocess.Popen([str(args.core.resolve()), '--home', str(args.home.resolve())],
        stdout=subprocess.PIPE, stderr=log, text=True, encoding='utf-8',
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    connection = json.loads(process.stdout.readline())
    def api(action, body=None):
        request = urllib.request.Request(f'http://127.0.0.1:{connection["port"]}/v1/{action}',
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + connection['token'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    return process, api

process, api = start()
try:
    api('settings', {'runtimePython': str(args.runtime.resolve()), 'model': str(args.model.resolve()), 'threads': 6})
    book = api('save_book', {'title': 'Recovery validation', 'chapters': [
        {'title': str(i+1), 'text': text} for i, text in enumerate([
            'The rain stopped before sunrise.',
            'She opened the window. The garden was quiet, and the morning light was soft.',
            'At last, she came home.'])]})['id']
    job = api('generate', {'book': book, 'speaker': 'Aiden', 'device': 'cpu'})['id']
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        row = next(j for j in api('state')['jobs'] if j['id'] == job)
        if row['completed'] >= 1:
            break
        if row['status'] == 'failed':
            raise AssertionError(row['error'])
        time.sleep(.2)
    assert 0 < row['completed'] < row['total']
    audio = args.home / 'library/audio' / job
    committed = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in audio.glob('*.pcm')}
    api('shutdown', {})
    process.wait(timeout=20)
    process, api = start()
    row = next(j for j in api('state')['jobs'] if j['id'] == job)
    assert row['status'] in ('paused', 'failed')
    recovered = row['status']
    api('resume', {'id': job})
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        row = next(j for j in api('state')['jobs'] if j['id'] == job)
        if row['status'] in ('done', 'failed'):
            break
        time.sleep(.5)
    assert row['status'] == 'done', row
    for name, sha in committed.items():
        assert hashlib.sha256((audio / name).read_bytes()).hexdigest() == sha
    result = {'status': 'passed', 'restartStatus': recovered, 'preservedSegments': len(committed),
              'finalSegments': row['completed'], 'device': row['actual_device']}
    (args.home / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))
finally:
    if process.poll() is None:
        api('shutdown', {})
        process.wait(timeout=20)
    log.close()
