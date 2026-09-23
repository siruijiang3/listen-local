"""Exercise an installed core without a developer Python on its PATH."""
import argparse
import json
import os
import subprocess
import time
import urllib.request
import urllib.error
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--core', required=True)
parser.add_argument('--home', required=True, type=Path)
parser.add_argument('--runtime', required=True)
parser.add_argument('--model', required=True)
args = parser.parse_args()
args.home.mkdir(parents=True, exist_ok=True)
log = (args.home / 'smoke.log').open('w', encoding='utf-8')
env = dict(os.environ, PATH=os.environ['SystemRoot'] + '\\System32')
process = subprocess.Popen([args.core, '--home', str(args.home)], stdout=subprocess.PIPE, stderr=log,
                           text=True, encoding='utf-8', env=env,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
connection = json.loads(process.stdout.readline())
base = f'http://127.0.0.1:{connection["port"]}/v1/'

def api(action, body=None):
    request = urllib.request.Request(base + action, data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + connection['token'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)

results = {}
try:
    try:
        urllib.request.urlopen(base + 'state')
        raise AssertionError('Unauthenticated API accepted')
    except urllib.error.HTTPError as error:
        assert error.code == 403
    results['unauthenticatedStatus'] = 403
    api('settings', {'runtimePython': str(Path(args.runtime).resolve()), 'model': str(Path(args.model).resolve()), 'threads': 6})
    book = api('save_book', {'title': 'Packaged CPU validation', 'chapters': [
        {'title': 'First', 'text': 'The rain stopped before sunrise.'},
        {'title': 'Last', 'text': 'At last, she came home.'}]})['id']
    job = api('generate', {'book': book, 'speaker': 'Aiden', 'device': 'cpu', 'mode': 'after'})['id']
    started = time.monotonic()
    while time.monotonic() - started < 300:
        state = api('state')
        row = next(j for j in state['jobs'] if j['id'] == job)
        if row['status'] in ('done', 'failed'):
            break
        time.sleep(1)
    assert row['status'] == 'done', row
    assert row['actual_device'] == 'cpu' and row['played'] == 0
    results.update(status=row['status'], device=row['actual_device'], audioSeconds=row['samples']/24000,
                   wallSeconds=time.monotonic()-started, generationSeconds=row['generation_seconds'],
                   exports=[{'name': e['name'], 'bytes': e['bytes']} for e in row['exports']])
    info = api('share', {'id': job})
    # Use loopback to avoid depending on Wi-Fi/firewall in this package test.
    url = info['url']
    from urllib.parse import urlsplit
    parsed = urlsplit(url)
    share_url = f'http://127.0.0.1:{parsed.port}{parsed.path}'
    with urllib.request.urlopen(share_url) as response:
        assert b'Packaged CPU validation' in response.read()
    with urllib.request.urlopen(urllib.request.Request(share_url.rstrip('/') + '/' + row['exports'][0]['id'],
                                                    headers={'Range': 'bytes=0-31'})) as response:
        assert response.status == 206 and len(response.read()) == 32
    results['shareRange'] = 206
    api('unshare', {})
    api('release', {})
    assert api('state')['engine'] is None
    results['explicitModelRelease'] = True
finally:
    api('shutdown', {})
    process.wait(timeout=20)
    log.close()
    results['exitCode'] = process.returncode
    (args.home / 'result.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(json.dumps(results, indent=2))
