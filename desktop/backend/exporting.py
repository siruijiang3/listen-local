import hashlib
import json
import os
import shutil
import subprocess
import threading
import zipfile
from pathlib import Path
from downloads import digest
from library import uid

_processes = set()
_process_lock = threading.Lock()


def abort_exports():
    with _process_lock:
        for process in list(_processes):
            if process.poll() is None:
                process.kill()


def ffmpeg_path():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def encode(files, target, codec, metadata=None):
    command = [ffmpeg_path(), '-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0']
    if metadata:
        command += ['-f', 'ffmetadata', '-i', str(metadata), '-map_metadata', '1', '-map_chapters', '1']
    command += ['-vn', '-threads', '2', '-c:a', codec, '-b:a', '96k' if codec == 'aac' else '128k']
    if codec == 'aac':
        command += ['-movflags', '+faststart', '-f', 'mp4']
    else:
        command += ['-f', 'mp3']
    command.append(str(target))
    log = target.with_suffix('.encoder.log')
    with log.open('wb') as error_log:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=error_log,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        with _process_lock:
            _processes.add(process)
        try:
            for file in files:
                with Path(file).open('rb') as audio:
                    shutil.copyfileobj(audio, process.stdin, length=256*1024)
            process.stdin.close()
            if process.wait() != 0:
                raise RuntimeError('音频封装失败：' + log.read_text(errors='replace')[-2000:])
        except Exception:
            process.kill()
            process.wait()
            raise
        finally:
            with _process_lock:
                _processes.discard(process)
    log.unlink(missing_ok=True)


def metadata_escape(text):
    return str(text).replace('\\', '\\\\').replace('=', '\\=').replace(';', '\\;').replace('#', '\\#').replace('\n', ' ')


def export_job(library, job_id):
    job = library.one('SELECT * FROM jobs WHERE id=?', (job_id,))
    segments = library.rows('SELECT * FROM segments WHERE job_id=? ORDER BY position', (job_id,))
    if not segments or any(s['status'] != 'done' for s in segments):
        raise ValueError('只能导出完整生成的书籍。')
    book = library.one('SELECT * FROM books WHERE id=?', (job['book_id'],))
    chapters = json.loads(book['chapters'])
    destination = library.root / 'exports' / job_id
    destination.mkdir(parents=True, exist_ok=True)
    metadata = destination / 'chapters.ffmeta'
    lines = [';FFMETADATA1', 'title=' + metadata_escape(book['title'])]
    cursor = 0
    for index, chapter in enumerate(chapters):
        samples = sum(s['samples'] for s in segments if s['chapter'] == index)
        lines += ['[CHAPTER]', 'TIMEBASE=1/24000', f'START={cursor}', f'END={cursor+samples}', 'title=' + metadata_escape(chapter['title'])]
        cursor += samples
    metadata.write_text('\n'.join(lines), encoding='utf-8')
    outputs = []
    m4b = destination / 'book.m4b'
    temp = destination / 'book.m4b.partial'
    encode([library.segment_path(s) for s in segments], temp, 'aac', metadata)
    os.replace(temp, m4b)
    outputs.append((book['title'] + '.m4b', m4b))
    mp3s = []
    for index, chapter in enumerate(chapters):
        file = destination / f'{index+1:04d}.mp3'
        temp = destination / f'{index+1:04d}.mp3.partial'
        encode([library.segment_path(s) for s in segments if s['chapter'] == index], temp, 'libmp3lame')
        os.replace(temp, file)
        mp3s.append(file)
        outputs.append((f'{index+1:04d} {chapter["title"]}.mp3', file))
    bundle = destination / 'chapters.zip'
    with zipfile.ZipFile(destination / 'chapters.zip.partial', 'w', compression=zipfile.ZIP_STORED) as archive:
        for mp3 in mp3s:
            archive.write(mp3, mp3.name)
        archive.writestr('chapters.json', json.dumps({'title': book['title'], 'chapters': [c['title'] for c in chapters]}, ensure_ascii=False, indent=2))
    os.replace(destination / 'chapters.zip.partial', bundle)
    outputs.append((book['title'] + ' 分章.zip', bundle))
    records = [(uid(), job_id, name, str(path), path.stat().st_size, digest(path)) for name, path in outputs]
    with library.lock, library.db:
        library.db.execute('DELETE FROM exports WHERE job_id=?', (job_id,))
        library.db.executemany('INSERT INTO exports VALUES(?,?,?,?,?,?)', records)
        library.db.execute("UPDATE jobs SET status='done',error=NULL WHERE id=?", (job_id,))
    return records
