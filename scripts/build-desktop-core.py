"""Build the lightweight backend in its own environment (never in the Torch env)."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
backend = ROOT / 'desktop/backend'
for manifest in ('model-manifest.json', 'runtime-manifest.json'):
    path = backend / 'resources' / manifest
    if not path.is_file():
        raise SystemExit(f'Missing {path}; run build-runtime.py and prepare-model-manifest.py first.')
    json.loads(path.read_text(encoding='utf-8'))
destination = ROOT / 'src-tauri/binaries'
destination.mkdir(parents=True, exist_ok=True)
subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--console',
                '--name', 'listen-core', '--distpath', str(destination), '--workpath', str(ROOT / '.qa/pyinstaller'),
                '--specpath', str(ROOT / '.qa'), '--paths', str(backend),
                '--add-data', f'{backend / "engine_worker.py"};.',
                '--add-data', f'{backend / "resources"};resources',
                '--add-data', f'{ROOT / "LICENSE"};licenses',
                '--add-data', f'{ROOT / "docs/THIRD_PARTY.md"};licenses',
                '--collect-all', 'imageio_ffmpeg', '--hidden-import', 'qrcode.image.svg',
                '--exclude-module', 'tkinter', '--exclude-module', 'PIL', str(backend / 'host.py')], check=True)
