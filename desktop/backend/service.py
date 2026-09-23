"""One library service, one model process, one serial generation queue."""
import base64
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from downloads import download, extract_runtime, digest
from exporting import export_job, abort_exports
from importers import import_book
from library import Library
from sharing import Share


def resource(name):
    return Path(getattr(sys, '_MEIPASS', Path(__file__).parent)) / name


class Service:
    def __init__(self, home):
        self.home = Path(home).resolve()
        self.home.mkdir(parents=True, exist_ok=True)
        self.settings_file = self.home / 'settings.json'
        self.settings = {'library': str(self.home / 'library'), 'runtimePython': '', 'model': '',
                         'threads': min(6, os.cpu_count() or 1)}
        if self.settings_file.exists():
            self.settings.update(json.loads(self.settings_file.read_text(encoding='utf-8')))
        self.library = Library(self.settings['library'])
        self.wake = threading.Event()
        self.stopping = threading.Event()
        self.control_lock = threading.RLock()
        self.engine = None
        self.engine_key = None
        self.engine_info = None
        self.engine_log = None
        self.last_use = 0
        self.active = None
        self.pause_requested = False
        self.cancel_requested = False
        self.share = None
        self.setup_status = None
        self.scheduler = threading.Thread(target=self.run, daemon=True)
        self.scheduler.start()

    def save_settings(self):
        temp = self.settings_file.with_suffix('.tmp')
        temp.write_text(json.dumps(self.settings, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temp, self.settings_file)

    def state(self):
        return {**self.library.snapshot(), 'settings': self.settings, 'engine': self.engine_info,
                'setup': self.setup_status, 'active': self.active, 'share': self.share.info() if self.share else None}

    def stop_engine(self):
        engine, self.engine = self.engine, None
        if engine:
            try:
                engine.stdin.write(json.dumps({'protocol': 1, 'command': 'quit'})+'\n')
                engine.stdin.flush()
                engine.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                engine.kill()
                engine.wait()
            engine.stdin.close()
            engine.stdout.close()
        if self.engine_log:
            self.engine_log.close()
            self.engine_log = None
        self.engine_key = self.engine_info = None

    def command(self, payload):
        if not self.engine:
            raise RuntimeError('推理进程未启动。')
        self.engine.stdin.write(json.dumps({'protocol': 1, **payload}, ensure_ascii=False)+'\n')
        self.engine.stdin.flush()
        while True:
            line = self.engine.stdout.readline()
            if not line:
                raise RuntimeError('推理进程意外退出，请检查运行包、内存和引擎日志。')
            message = json.loads(line)
            if message['type'] == 'error':
                raise RuntimeError(message['message'])
            yield message
            if message['type'] in ('done', 'ready'):
                return

    def prepare(self, job):
        key = (self.settings['runtimePython'], self.settings['model'], self.settings['threads'], job['device'])
        if self.engine and self.engine_key == key and self.engine.poll() is None:
            return self.engine_info
        self.stop_engine()
        python, model, threads, device = key
        if not python or not Path(python).is_file() or not model or not (Path(model)/'config.json').is_file():
            raise ValueError('请先在设置中下载运行包与模型，或选择已有运行环境和模型目录。')
        self.engine_log = (self.home / 'engine.log').open('w', encoding='utf-8')
        env = dict(os.environ, PYTHONUNBUFFERED='1', PYTHONIOENCODING='utf-8', TOKENIZERS_PARALLELISM='false')
        self.engine = subprocess.Popen([python, '-u', str(resource('engine_worker.py'))], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=self.engine_log, text=True, encoding='utf-8',
                                      env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        info = list(self.command({'command': 'prepare', 'model': model, 'threads': threads, 'device': device}))[-1]
        self.engine_key, self.engine_info = key, info
        return info

    def run(self):
        while not self.stopping.is_set():
            jobs = self.library.rows("SELECT * FROM jobs WHERE status='queued' ORDER BY created LIMIT 1")
            if not jobs:
                if self.engine and time.monotonic()-self.last_use >= 300:
                    self.stop_engine()
                self.wake.wait(timeout=15 if self.engine else None)
                self.wake.clear()
                continue
            job = jobs[0]
            with self.control_lock:
                self.active = job['id']
                self.pause_requested = self.cancel_requested = False
            try:
                self.library.execute("UPDATE jobs SET status='preparing',error=NULL WHERE id=?", (job['id'],))
                pending = self.library.rows("SELECT id FROM segments WHERE job_id=? AND status!='done'", (job['id'],))
                if pending:
                    info = self.prepare(job)
                    self.library.execute("UPDATE jobs SET status='running',actual_device=?,error=? WHERE id=?", (info['device'], info.get('reason'), job['id']))
                for segment in self.library.rows('SELECT * FROM segments WHERE job_id=? ORDER BY position', (job['id'],)):
                    if self.stopping.is_set() or self.pause_requested or self.cancel_requested:
                        break
                    if segment['status'] == 'done':
                        continue
                    self.library.execute("UPDATE segments SET status='running',samples=0 WHERE id=?", (segment['id'],))
                    samples = 0
                    elapsed = 0
                    partial = self.library.segment_path(segment, True)
                    with partial.open('wb') as audio:
                        if segment['text'].strip():
                            for message in self.command({'command': 'generate', 'text': segment['text'], 'speaker': job['speaker'],
                                                         'language': job['language'], 'seed': 42+segment['position']}):
                                if message['type'] == 'audio':
                                    pcm = base64.b64decode(message['pcm'], validate=True)
                                    if len(pcm) != message['samples'] * 2:
                                        raise ValueError('引擎 PCM 长度不匹配。')
                                    audio.write(pcm)
                                    audio.flush()
                                    samples += message['samples']
                                    self.library.execute('UPDATE segments SET samples=? WHERE id=?', (samples, segment['id']))
                                elif message['type'] == 'done':
                                    elapsed = message['seconds']
                        audio.flush()
                        os.fsync(audio.fileno())
                    self.library.commit_segment(segment, samples)
                    self.library.execute('UPDATE jobs SET generation_seconds=generation_seconds+? WHERE id=?', (elapsed, job['id']))
                    self.last_use = time.monotonic()
                remaining = self.library.one("SELECT COUNT(*) count FROM segments WHERE job_id=? AND status!='done'", (job['id'],))['count']
                if self.cancel_requested or self.pause_requested or self.stopping.is_set():
                    status = 'cancelled' if self.cancel_requested else 'paused'
                    self.library.execute('UPDATE jobs SET status=? WHERE id=?', (status, job['id']))
                elif remaining == 0:
                    self.library.execute("UPDATE jobs SET status='exporting',rtf=generation_seconds/((SELECT SUM(samples) FROM segments WHERE job_id=?)/24000.0) WHERE id=?", (job['id'], job['id']))
                    export_job(self.library, job['id'])
            except Exception as error:
                self.library.execute("UPDATE segments SET status='pending',samples=0 WHERE job_id=? AND status='running'", (job['id'],))
                interrupted = self.stopping.is_set()
                self.library.execute("UPDATE jobs SET status=?,error=? WHERE id=?",
                    ('paused' if interrupted else 'failed',
                     '退出时保存，未完成段将在恢复时重做。' if interrupted else str(error), job['id']))
                self.stop_engine()
            finally:
                self.last_use = time.monotonic()
                self.active = None
        self.stop_engine()

    def install(self, flavor):
        if self.active or self.library.rows("SELECT id FROM jobs WHERE status='queued'") or (self.setup_status and self.setup_status.get('running')):
            raise ValueError('请等待当前任务完成。')
        if flavor not in ('cpu', 'cuda'):
            raise ValueError('运行包类型无效。')
        self.setup_status = {'running': True, 'message': '准备下载', 'bytes': 0, 'total': 0}

        def worker():
            try:
                manifest = json.loads(resource('resources/runtime-manifest.json').read_text(encoding='utf-8'))
                pack = manifest[flavor]
                runtime = self.home / 'runtimes' / pack['id']
                if not (runtime / 'python.exe').exists():
                    def progress(done, total):
                        self.setup_status.update(message='下载原生运行包', bytes=done, total=total)
                    archive = self.home / 'downloads' / (pack['id'] + '.zip')
                    if pack.get('parts'):
                        chunks = []
                        for index, part in enumerate(pack['parts']):
                            chunk = archive.with_name(archive.name + f'.{index+1:03d}')
                            download(part['url'], chunk, part['sha256'], progress)
                            chunks.append(chunk)
                        if not archive.exists() or digest(archive) != pack['sha256']:
                            with archive.open('wb') as output:
                                for chunk in chunks:
                                    with chunk.open('rb') as source:
                                        shutil.copyfileobj(source, output, 1024*1024)
                        if digest(archive) != pack['sha256']:
                            raise ValueError('运行包合并校验失败。')
                    else:
                        download(pack['url'], archive, pack['sha256'], progress)
                    self.setup_status.update(message='解压运行包')
                    extract_runtime(archive, runtime)
                model = self.home / 'models' / 'qwen-0.6b'
                files = json.loads(resource('resources/model-manifest.json').read_text(encoding='utf-8'))
                for file in files['files']:
                    self.setup_status.update(message='下载模型：' + file['path'])
                    download(file['url'], model / file['path'], file['sha256'],
                             lambda done, total: self.setup_status.update(bytes=done, total=total))
                self.settings.update(runtimePython=str(runtime / 'python.exe'), model=str(model))
                self.save_settings()
                self.setup_status.update(running=False, message='运行包与模型已就绪')
            except Exception as error:
                self.setup_status.update(running=False, message=str(error), error=True)
        threading.Thread(target=worker, daemon=True).start()

    def action(self, action, body):
        if action == 'import':
            return import_book(body['path'])
        if action == 'save_book':
            return {'id': self.library.add_book(body['title'], body['chapters'])}
        if action == 'book':
            book = self.library.one('SELECT * FROM books WHERE id=?', (body['id'],))
            book['chapters'] = json.loads(book['chapters'])
            return book
        if action == 'generate':
            if self.setup_status and self.setup_status.get('running'):
                raise ValueError('请先等待模型安装完成。')
            job = self.library.new_job(body['book'], body['speaker'], body.get('device', 'auto'), body.get('mode', 'after'))
            self.wake.set()
            return {'id': job}
        if action in ('pause', 'cancel', 'resume'):
            job = self.library.one('SELECT * FROM jobs WHERE id=?', (body['id'],))
            with self.control_lock:
                if action == 'resume':
                    if job['status'] not in ('paused', 'failed', 'cancelled'):
                        raise ValueError('当前任务不能恢复。')
                    self.library.execute("UPDATE jobs SET status='queued',error=NULL WHERE id=?", (job['id'],))
                    self.wake.set()
                elif self.active == job['id']:
                    if job['status'] == 'exporting':
                        raise ValueError('音频已经生成，正在封装成品，请等待封装完成。')
                    if action == 'pause':
                        self.pause_requested = True
                    else:
                        self.cancel_requested = True
                    self.library.execute('UPDATE jobs SET error=? WHERE id=?', ('当前自然段完成后暂停。' if action == 'pause' else '当前自然段完成后取消。', job['id']))
                elif job['status'] == 'queued':
                    self.library.execute('UPDATE jobs SET status=? WHERE id=?', ('paused' if action == 'pause' else 'cancelled', job['id']))
                else:
                    raise ValueError('任务当前不可暂停或取消。')
            return {}
        if action == 'played':
            value = max(0, float(body['seconds']))
            self.library.execute('UPDATE jobs SET played=?,playback_json=? WHERE id=?', (value, json.dumps(body.get('metrics')), body['id']))
            return {}
        if action == 'settings':
            if self.active or self.library.rows("SELECT id FROM jobs WHERE status='queued'") or (self.setup_status and self.setup_status.get('running')):
                raise ValueError('请先暂停全部任务并等待安装完成，再修改设置。')
            self.stop_engine()
            settings = {**self.settings, **{k:v for k,v in body.items() if k in ('library', 'runtimePython', 'model', 'threads')}}
            settings['threads'] = max(1, min(int(settings['threads']), os.cpu_count() or 1))
            if not isinstance(settings['library'], str) or not settings['library']:
                raise ValueError('书库目录无效。')
            if settings['library'] != self.settings['library']:
                if self.share:
                    self.share.close()
                    self.share = None
                old = self.library
                self.library = Library(settings['library'])
                old.db.close()
            self.settings = settings
            self.save_settings()
            return {}
        if action == 'release':
            if self.active:
                raise ValueError('任务运行时不能释放模型。')
            self.stop_engine()
            return {}
        if action == 'install':
            self.install(body['flavor'])
            return {}
        if action == 'share':
            job = self.library.one("SELECT j.*,b.title FROM jobs j JOIN books b ON b.id=j.book_id WHERE j.id=?", (body['id'],))
            if job['status'] != 'done':
                raise ValueError('只有完成封装的作品可以分享。')
            records = self.library.rows('SELECT * FROM exports WHERE job_id=?', (job['id'],))
            if not records or any(not Path(r['path']).is_file() for r in records):
                raise ValueError('成品文件不完整，请重新导出。')
            if self.share:
                self.share.close()
            self.share = Share(records, job['title'])
            return self.share.info()
        if action == 'unshare':
            if self.share:
                self.share.close()
                self.share = None
            return {}
        if action == 'copy_export':
            record = self.library.one('SELECT * FROM exports WHERE id=?', (body['id'],))
            destination = Path(body['directory']).resolve()
            if not destination.is_dir():
                raise ValueError('目标目录不存在。')
            # Fixed artifact name prevents title characters becoming paths.
            target = destination / (record['job_id'][:8] + '-' + Path(record['path']).name)
            if target.exists():
                raise ValueError('目标文件已存在，请选择其他目录。')
            shutil.copyfile(record['path'], target)
            return {'path': str(target)}
        raise ValueError('未知操作。')

    def close(self):
        self.stopping.set()
        self.wake.set()
        if self.share:
            self.share.close()
            self.share = None
        # Graceful segment-boundary shutdown; the launcher has an upper time bound.
        self.scheduler.join(timeout=5)
        abort_exports()
        engine = self.engine
        if self.scheduler.is_alive() and engine:
            try:
                engine.kill()
            except OSError:
                pass  # The scheduler may have already finished the worker.
            self.scheduler.join(timeout=5)
        self.library.execute("UPDATE jobs SET status='paused',error='退出时保存，未完成段将在恢复时重做。' WHERE status IN ('queued','preparing','running','exporting')")
