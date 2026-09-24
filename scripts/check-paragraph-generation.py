"""Real packaged-core check of paragraph boundaries, persisted PCM and reader ranges."""
import argparse
import json
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
for name in ('core', 'home', 'runtime', 'model'):
    parser.add_argument('--' + name, required=True, type=Path)
args = parser.parse_args()
args.home.mkdir(parents=True, exist_ok=True)
log = (args.home / 'core.log').open('w', encoding='utf-8')
process = subprocess.Popen([str(args.core.resolve()), '--home', str(args.home.resolve())],
    stdout=subprocess.PIPE, stderr=log, text=True, encoding='utf-8',
    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
connection = json.loads(process.stdout.readline())
base = f'http://127.0.0.1:{connection["port"]}/v1/'


def api(action, body=None):
    request = urllib.request.Request(base + action,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + connection['token'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


results = {'voices': [], 'passed': False}
try:
    api('settings', {'runtimePython': str(args.runtime.resolve()), 'model': str(args.model.resolve())})
    for speaker in ('Serena', 'Uncle_Fu', 'Aiden'):
        paragraphs = ['清晨，林岚推开窗，看见街边的梧桐树。', '她把书放进背包，沿着河岸走向图书馆。', '傍晚归来时，桌上的茶已经凉了。']
        if speaker == 'Aiden':
            paragraphs = ['At sunrise, Mara opened the window and listened to the birds.',
                          'She put a book in her bag and walked to the library.',
                          'When she came home that evening, the tea on her desk was cold.']
        source = '\n\n'.join(paragraphs)
        book = api('save_book', {'title': 'Paragraph validation - ' + speaker,
                                'chapters': [{'title': 'A day by the river', 'text': source}]})['id']
        job = api('generate', {'book': book, 'speaker': speaker, 'device': 'gpu', 'mode': 'live'})['id']
        started = time.monotonic()
        partial_seen = False
        while time.monotonic() - started < 300:
            row = next(j for j in api('state')['jobs'] if j['id'] == job)
            index = api('reader?job=' + job)
            partial_seen |= index['samples'] > 0 and index['completed'] < index['total']
            if row['status'] in ('done', 'failed'):
                break
            time.sleep(0.7)
        assert row['status'] == 'done', row.get('error')
        assert row['actual_device'] == 'cuda'
        index = api('reader?job=' + job)
        text = api('reader?job=' + job + '&chapter=0')['text']
        assert len(index['segments']) == 3
        for segment, expected in zip(index['segments'], paragraphs):
            actual = text.encode('utf-16-le')[segment['start'] * 2:segment['end'] * 2].decode('utf-16-le')
            assert actual.strip() == expected
            assert segment['sampleEnd'] > segment['sampleStart']
        assert index['samples'] == row['samples']
        try:
            urllib.request.urlopen(base + 'reader?job=' + job, timeout=10)
            raise AssertionError('Reader accepted unauthenticated request')
        except urllib.error.HTTPError as error:
            assert error.code == 403
        results['voices'].append({'speaker': speaker, 'device': row['actual_device'], 'paragraphs': paragraphs,
            'audioSeconds': row['samples'] / 24000, 'generationSeconds': row['generation_seconds'],
            'wallSeconds': time.monotonic() - started, 'partialIndexObserved': partial_seen,
            'segments': [{k: s[k] for k in ('position', 'start', 'end', 'sampleStart', 'sampleEnd')} for s in index['segments']]})
        print(speaker, 'passed', flush=True)
    results['passed'] = True
finally:
    api('shutdown', {})
    process.wait(timeout=20)
    log.close()
    results['exitCode'] = process.returncode
    (args.home / 'result.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
