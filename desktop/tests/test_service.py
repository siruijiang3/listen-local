import base64
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from service import Service


class ServiceTests(unittest.TestCase):
    def test_generation_does_not_wait_for_playback_and_resume_skips_commits(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch('service.export_job') as export:
                app = Service(temp)
                try:
                    calls = []
                    app.prepare = lambda _: {'device': 'cpu'}
                    def command(payload):
                        calls.append(payload['text'])
                        yield {'type': 'audio', 'samples': 24000*35, 'pcm': base64.b64encode(b'\x00\x00' * 24000*35).decode()}
                        yield {'type': 'done', 'seconds': 0.01}
                    app.command = command
                    def exported(lib, job):
                        lib.execute("UPDATE jobs SET status='done' WHERE id=?", (job,))
                    export.side_effect = exported
                    book = app.action('save_book', {'title': '测试', 'chapters': [{'title': '一', 'text': '第一段。'}, {'title': '二', 'text': '第二段。'}]})['id']
                    job = app.action('generate', {'book': book, 'speaker': 'Serena'})['id']
                    deadline = time.monotonic()+10
                    while time.monotonic() < deadline:
                        row = app.library.one('SELECT * FROM jobs WHERE id=?', (job,))
                        if row['status'] == 'done':
                            break
                        time.sleep(.03)
                    self.assertEqual(row['status'], 'done')
                    self.assertEqual(row['played'], 0)
                    self.assertEqual(len(calls), 2)
                    self.assertEqual(app.library.snapshot()['jobs'][0]['samples'], 70*24000)
                    app.library.execute("UPDATE jobs SET status='paused' WHERE id=?", (job,))
                    app.action('resume', {'id': job})
                    time.sleep(.2)
                    self.assertEqual(len(calls), 2)
                finally:
                    app.close()
                    app.library.db.close()


if __name__ == '__main__':
    unittest.main()
