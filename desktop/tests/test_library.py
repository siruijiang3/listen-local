import io
import json
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from importers import import_book, split_text
from library import Library
from downloads import extract_runtime, digest
from sharing import Share
from exporting import export_job


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.library = Library(self.root / 'library')

    def tearDown(self):
        self.library.db.close()
        self.temp.cleanup()

    def job(self):
        book = self.library.add_book('书名 / 保留符号', [{'title': '第一章', 'text': '你好。\n世界。'}, {'title': '第二章', 'text': '下一章。'}])
        return self.library.new_job(book, 'Serena', 'cpu', 'after')

    def fill(self, job):
        for segment in self.library.rows('SELECT * FROM segments WHERE job_id=?', (job,)):
            self.library.segment_path(segment, True).write_bytes(b'\x00\x00' * 24000)
            self.library.commit_segment(segment, 24000)

    def test_source_ranges_and_long_tail(self):
        text = '  雨停了。\n\n' + '没有标点' * 250 + '\n\t尾巴。   '
        pieces = list(split_text(text, 'Chinese'))
        self.assertEqual(''.join(p[2] for p in pieces), text)
        self.assertEqual(pieces[-1][1], len(text))
        for start, end, part in pieces:
            self.assertEqual(text[start:end], part)

    def test_crash_recovery_keeps_commits_and_discards_partial(self):
        job = self.job()
        segments = self.library.rows('SELECT * FROM segments WHERE job_id=? ORDER BY position', (job,))
        first, second = segments[:2]
        self.library.segment_path(first, True).write_bytes(b'\x01\x00' * 20)
        self.library.commit_segment(first, 20)
        self.library.execute("UPDATE segments SET status='running',samples=8 WHERE id=?", (second['id'],))
        self.library.execute("UPDATE jobs SET status='running' WHERE id=?", (job,))
        self.library.db.close()
        self.library = Library(self.root / 'library')
        state = self.library.snapshot()['jobs'][0]
        self.assertEqual((state['status'], state['completed'], state['samples']), ('paused', 1, 20))
        self.assertEqual(self.library.audio(job, 0, 100), b'\x01\x00' * 20)

    def test_import_epub_spine_order_and_hidden_content(self):
        path = self.root / 'test.epub'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
            z.writestr('OEBPS/content.opf', '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>')
            z.writestr('OEBPS/a.xhtml', '<h1>后章</h1><p>你好 &amp; 世界</p><script>不要读</script>')
            z.writestr('OEBPS/b.xhtml', '<h1>前章</h1><p>先读我</p>')
        book = import_book(path)
        self.assertEqual([c['title'] for c in book['chapters']], ['前章', '后章'])
        self.assertNotIn('不要读', book['chapters'][1]['text'])
        self.assertIn('&', book['chapters'][1]['text'])

    def test_gb18030(self):
        path = self.root / '书.txt'
        path.write_bytes('你好，世界。'.encode('gb18030'))
        self.assertEqual(import_book(path)['chapters'][0]['text'], '你好，世界。')

    def test_zip_path_traversal(self):
        path = self.root / 'bad.zip'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('../escaped', 'bad')
        with self.assertRaises(ValueError):
            extract_runtime(path, self.root / 'runtime')
        self.assertFalse((self.root / 'escaped').exists())

    def test_exports_fail_closed(self):
        with self.assertRaises(ValueError):
            export_job(self.library, self.job())

    def test_encoding_and_private_range_download(self):
        job = self.job()
        self.fill(job)
        export_job(self.library, job)
        records = self.library.rows('SELECT * FROM exports WHERE job_id=?', (job,))
        self.assertEqual(len(records), 4)
        for record in records:
            self.assertEqual(digest(record['path']), record['sha256'])
            self.assertGreater(record['bytes'], 0)
        share = Share(records, '标题 <安全>')
        try:
            url = f'http://127.0.0.1:{share.server.server_port}/share/{share.token}/{records[0]["id"]}'
            with urllib.request.urlopen(urllib.request.Request(url, headers={'Range': 'bytes=0-15'})) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.read(), Path(records[0]['path']).read_bytes()[:16])
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(url, headers={'Range': 'bytes=999999999999-'}))
            self.assertEqual(error.exception.code, 416)
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(url.replace(share.token, 'wrong'))
            self.assertTrue(share.info()['qr'].startswith('data:image/svg+xml;base64,'))
        finally:
            share.close()


if __name__ == '__main__':
    unittest.main()
