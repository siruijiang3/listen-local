"""Record official pinned model files; weights themselves never enter Git."""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import quote

parser = argparse.ArgumentParser()
parser.add_argument('model', type=Path)
args = parser.parse_args()
revision = '85e237c12c027371202489a0ec509ded67b5e4b5'
files = []
for path in sorted(args.model.rglob('*')):
    relative = path.relative_to(args.model)
    if not path.is_file() or any(part.startswith('.') for part in relative.parts) or path.suffix in ('.md',):
        continue
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            checksum.update(chunk)
    files.append({'path': relative.as_posix(), 'bytes': path.stat().st_size, 'sha256': checksum.hexdigest(),
                  'url': f'https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice/resolve/{revision}/{quote(relative.as_posix())}'})
target = Path(__file__).resolve().parents[1] / 'desktop/backend/resources/model-manifest.json'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps({'repo': 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice', 'revision': revision, 'files': files}, indent=2), encoding='utf-8')
print(json.dumps({'files': len(files), 'bytes': sum(f['bytes'] for f in files)}))
