"""Small transactional library; PCM is kept in files, not SQLite or JS arrays."""
import hashlib
import json
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from importers import split_text, validate_chapters

REVISION = '85e237c12c027371202489a0ec509ded67b5e4b5'
VOICES = {'Serena': 'Chinese', 'Uncle_Fu': 'Chinese', 'Aiden': 'English'}


def uid():
    return uuid.uuid4().hex


class Library:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / 'library.sqlite3', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
            PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY,title TEXT NOT NULL,created REAL NOT NULL,chapters TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,book_id TEXT REFERENCES books(id),speaker TEXT,language TEXT,
              device TEXT,mode TEXT,status TEXT,error TEXT,created REAL,settings TEXT,played REAL DEFAULT 0,
              generation_seconds REAL DEFAULT 0,actual_device TEXT,rtf REAL);
            CREATE TABLE IF NOT EXISTS segments(id TEXT PRIMARY KEY,job_id TEXT REFERENCES jobs(id),position INTEGER,
              chapter INTEGER,start INTEGER,end INTEGER,text TEXT,status TEXT DEFAULT 'pending',samples INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,job_id TEXT REFERENCES jobs(id),name TEXT,path TEXT,bytes INTEGER,sha256 TEXT);
            CREATE UNIQUE INDEX IF NOT EXISTS segment_order ON segments(job_id,position);
            PRAGMA user_version=1;
        ''')
        if 'playback_json' not in {r[1] for r in self.db.execute('PRAGMA table_info(jobs)')}:
            self.db.execute("ALTER TABLE jobs ADD COLUMN playback_json TEXT")
        self.db.execute("UPDATE jobs SET status='paused',error='上次运行中断，可从未完成段恢复。' WHERE status IN ('running','preparing','queued','exporting')")
        self.db.execute("UPDATE segments SET status='pending',samples=0 WHERE status='running'")
        self.db.commit()

    def execute(self, sql, args=()):
        with self.lock:
            cursor = self.db.execute(sql, args)
            self.db.commit()
            return cursor

    def rows(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        rows = self.rows(sql, args)
        if not rows:
            raise ValueError('项目不存在。')
        return rows[0]

    def add_book(self, title, chapters):
        validate_chapters(chapters)
        if not isinstance(title, str) or not title.strip():
            raise ValueError('请输入书名。')
        book_id = uid()
        self.execute('INSERT INTO books VALUES(?,?,?,?)', (book_id, title[:300], time.time(), json.dumps(chapters, ensure_ascii=False)))
        return book_id

    def new_job(self, book_id, speaker, device, mode):
        if speaker not in VOICES or device not in ('auto', 'gpu', 'cpu') or mode not in ('live', 'after'):
            raise ValueError('声音、设备或播放模式无效。')
        book = self.one('SELECT * FROM books WHERE id=?', (book_id,))
        job_id, language = uid(), VOICES[speaker]
        settings = {'model': 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice', 'revision': REVISION,
                    'frames': 8, 'temperature': 0.9, 'top_k': 50, 'top_p': 1, 'repetition_penalty': 1.05,
                    'sourceHash': hashlib.sha256(book['chapters'].encode()).hexdigest()}
        with self.lock:
            with self.db:
                self.db.execute('INSERT INTO jobs(id,book_id,speaker,language,device,mode,status,created,settings) VALUES(?,?,?,?,?,?,?,?,?)',
                                (job_id, book_id, speaker, language, device, mode, 'queued', time.time(), json.dumps(settings)))
                position = 0
                for chapter, source in enumerate(json.loads(book['chapters'])):
                    for start, end, text in split_text(source['text'], language):
                        self.db.execute('INSERT INTO segments(id,job_id,position,chapter,start,end,text) VALUES(?,?,?,?,?,?,?)',
                                        (uid(), job_id, position, chapter, start, end, text))
                        position += 1
        (self.root / 'audio' / job_id).mkdir(parents=True)
        return job_id

    def segment_path(self, segment, partial=False):
        return self.root / 'audio' / segment['job_id'] / (segment['id'] + ('.partial' if partial else '.pcm'))

    def commit_segment(self, segment, samples):
        part = self.segment_path(segment, True)
        if part.stat().st_size != samples * 2:
            raise ValueError('音频长度校验失败。')
        os.replace(part, self.segment_path(segment))
        self.execute("UPDATE segments SET status='done',samples=? WHERE id=?", (samples, segment['id']))

    def snapshot(self):
        books = self.rows('SELECT id,title,created FROM books ORDER BY created DESC')
        jobs = self.rows('''SELECT j.*,b.title,(SELECT COUNT(*) FROM segments s WHERE s.job_id=j.id) total,
          (SELECT COUNT(*) FROM segments s WHERE s.job_id=j.id AND s.status='done') completed,
          (SELECT COALESCE(SUM(samples),0) FROM segments s WHERE s.job_id=j.id) samples
          FROM jobs j JOIN books b ON j.book_id=b.id ORDER BY j.created DESC''')
        for job in jobs:
            job['exports'] = self.rows('SELECT id,name,bytes,sha256 FROM exports WHERE job_id=?', (job['id'],))
        return {'books': books, 'jobs': jobs}

    def audio(self, job_id, offset, count):
        if offset < 0 or offset % 2 or count <= 0:
            raise ValueError('无效音频范围。')
        count = min(count, 192000)
        result = bytearray()
        for segment in self.rows('SELECT * FROM segments WHERE job_id=? ORDER BY position', (job_id,)):
            if segment['status'] not in ('done', 'running'):
                break
            size = segment['samples'] * 2
            if offset >= size:
                offset -= size
                continue
            path = self.segment_path(segment, segment['status'] != 'done')
            try:
                stream = path.open('rb')
            except FileNotFoundError:
                # A writer can rename the flushed partial before its SQLite commit.
                stream = self.segment_path(segment).open('rb')
            with stream:
                stream.seek(offset)
                result.extend(stream.read(min(count-len(result), size-offset)))
            offset = 0
            if len(result) >= count:
                break
        return bytes(result)
