"""Pinned, resumable downloads and safe extraction of released runtime packs."""
import hashlib
import json
import os
import shutil
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            result.update(chunk)
    return result.hexdigest()


def download(url, target, sha256, progress=lambda *_: None):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and digest(target) == sha256:
        return
    part = target.with_name(target.name + '.download')
    if part.exists() and digest(part) == sha256:
        os.replace(part, target)
        return
    offset = part.stat().st_size if part.exists() else 0
    request = urllib.request.Request(url, headers={'User-Agent': 'ListenLocal/0.1', **({'Range': f'bytes={offset}-'} if offset else {})})
    with urllib.request.urlopen(request, timeout=60) as response:
        resumed = response.status == 206 and response.headers.get('Content-Range', '').startswith(f'bytes {offset}-')
        if response.status == 206 and not resumed:
            raise ValueError('下载服务器返回错误的续传范围。')
        if not resumed:
            offset = 0
        total = offset + int(response.headers.get('Content-Length', 0))
        with part.open('ab' if resumed else 'wb') as stream:
            while chunk := response.read(1024*1024):
                stream.write(chunk)
                offset += len(chunk)
                progress(offset, total)
    if digest(part) != sha256:
        part.unlink(missing_ok=True)
        raise ValueError('下载文件 SHA-256 校验失败，请重试。')
    os.replace(part, target)


def extract_runtime(archive, target):
    target = Path(target)
    staging = target.with_name(target.name + '.installing')
    # The staging path is fixed by the application, never supplied by an archive.
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    try:
        with zipfile.ZipFile(archive) as package:
            for item in package.infolist():
                name = PurePosixPath(item.filename.replace('\\', '/'))
                if name.is_absolute() or '..' in name.parts or ':' in item.filename or (item.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('运行包包含不安全路径。')
                output = (staging / str(name)).resolve()
                if not output.is_relative_to(staging.resolve()):
                    raise ValueError('运行包路径越界。')
                if item.is_dir():
                    output.mkdir(parents=True, exist_ok=True)
                else:
                    output.parent.mkdir(parents=True, exist_ok=True)
                    with package.open(item) as source, output.open('wb') as dest:
                        shutil.copyfileobj(source, dest)
        if not (staging / 'python.exe').exists():
            raise ValueError('运行包缺少 Python。')
        if target.exists():
            raise ValueError('运行目录已经存在，请先选择新的版本目录。')
        staging.rename(target)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
