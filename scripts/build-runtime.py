"""Reproducible Windows runtime pack: embeddable Python + locked wheels.

Build CPU and CUDA separately. No model or local site-packages are copied.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--flavor', choices=['cpu', 'cuda'], required=True)
parser.add_argument('--version', default='0.1.0')
parser.add_argument('--python-archive', type=Path)
parser.add_argument('--reuse-environment', type=Path, help='Local verification only: build from an existing environment matching the committed lock.')
args = parser.parse_args()
release = ROOT / '.qa/release'
release.mkdir(parents=True, exist_ok=True)
archive = args.python_archive or ROOT / '.qa/python-3.12.10-embed-amd64.zip'
if not archive.exists():
    urllib.request.urlretrieve('https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip', archive)
python_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
if python_hash != '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3':
    raise SystemExit('Official Python 3.12.10 embedded archive checksum mismatch')
pack_id = f'listen-runtime-{args.flavor}-{args.version}-win-x64'
target = ROOT / '.qa/runtime-build' / pack_id
target.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive) as embedded:
    embedded.extractall(target)
(target / 'python312._pth').write_text('python312.zip\n.\nLib/site-packages\nimport site\n', encoding='utf-8')
packages = target / 'Lib/site-packages'
if args.reuse_environment:
    shutil.copytree(args.reuse_environment / 'Lib/site-packages', packages, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'pip', 'pip-*.dist-info'))
else:
    flavor = 'cu124' if args.flavor == 'cuda' else 'cpu'
    lock = ROOT / f'desktop/backend/requirements-{args.flavor}-lock.txt'
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--only-binary=:all:', '--no-binary=sox', '--target', str(packages),
                    '--extra-index-url', f'https://download.pytorch.org/whl/{flavor}', '-r', str(lock)], check=True)
metadata = {'python': '3.12.10', 'pythonArchiveSha256': python_hash, 'flavor': args.flavor, 'version': args.version}
(target / 'runtime.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
output = release / (pack_id + '.zip')
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as bundle:
    for path in sorted(target.rglob('*')):
        if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc':
            bundle.write(path, path.relative_to(target).as_posix())
checksum = hashlib.sha256()
with output.open('rb') as stream:
    for chunk in iter(lambda: stream.read(1024*1024), b''):
        checksum.update(chunk)
manifest_file = ROOT / 'desktop/backend/resources/runtime-manifest.json'
manifest_file.parent.mkdir(parents=True, exist_ok=True)
manifest = json.loads(manifest_file.read_text(encoding='utf-8')) if manifest_file.exists() else {}
manifest[args.flavor] = {'id': pack_id, 'bytes': output.stat().st_size, 'sha256': checksum.hexdigest(),
                       'url': f'https://github.com/siruijiang3/listen-local/releases/download/v{args.version}/{output.name}', **metadata}
if output.stat().st_size > 1_900_000_000:
    parts = []
    with output.open('rb') as source:
        index = 0
        while source.tell() < output.stat().st_size:
            index += 1
            part = output.with_name(output.name + f'.{index:03d}')
            sha = hashlib.sha256()
            remaining = 1_000_000_000
            with part.open('wb') as dest:
                while remaining > 0 and (chunk := source.read(min(1024*1024, remaining))):
                    dest.write(chunk)
                    sha.update(chunk)
                    remaining -= len(chunk)
            parts.append({'url': f'https://github.com/siruijiang3/listen-local/releases/download/v{args.version}/{part.name}',
                          'bytes': part.stat().st_size, 'sha256': sha.hexdigest()})
    manifest[args.flavor]['parts'] = parts
    del manifest[args.flavor]['url']
manifest_file.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(json.dumps(manifest[args.flavor]))
