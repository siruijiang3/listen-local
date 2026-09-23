import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from downloads import download
from library import Library


class BoundaryTests(unittest.TestCase):
    def test_download_finished_before_rename_needs_no_network(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'model'
            target.with_name('model.download').write_bytes(b'complete')
            with patch('urllib.request.urlopen', side_effect=AssertionError('Unexpected network')):
                download('https://invalid.example/file', target, hashlib.sha256(b'complete').hexdigest())
            self.assertEqual(target.read_bytes(), b'complete')

    def test_audio_remains_readable_between_rename_and_sqlite_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            library = Library(directory)
            try:
                book = library.add_book('test', [{'title': 'one', 'text': 'hello'}])
                job = library.new_job(book, 'Aiden', 'cpu', 'after')
                segment = library.rows('SELECT * FROM segments')[0]
                library.segment_path(segment).write_bytes(b'\x01\x00' * 8)
                library.execute("UPDATE segments SET status='running',samples=8")
                self.assertEqual(library.audio(job, 0, 32), b'\x01\x00' * 8)
            finally:
                library.db.close()

    def test_disk_full_cannot_commit_segment(self):
        with tempfile.TemporaryDirectory() as directory:
            library = Library(directory)
            try:
                book = library.add_book('test', [{'title': 'one', 'text': 'hello'}])
                library.new_job(book, 'Aiden', 'cpu', 'after')
                segment = library.rows('SELECT * FROM segments')[0]
                library.segment_path(segment, True).write_bytes(b'\x00\x00')
                with patch('library.os.replace', side_effect=OSError(28, 'No space left on device')):
                    with self.assertRaises(OSError):
                        library.commit_segment(segment, 1)
                self.assertEqual(library.rows('SELECT status FROM segments')[0]['status'], 'pending')
            finally:
                library.db.close()
