import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from library import Library


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.library = Library(self.temp.name)
        self.text = '😀𠀀中文。\n' * 90 + '   尾声。\n\t'
        self.book = self.library.add_book('原文版本', [
            {'title': '长章', 'text': self.text}, {'title': '空白片段', 'text': ' ' * 180 + '正文。'},
            {'title': 'English', 'text': 'The end. 😀'}])
        self.job = self.library.new_job(self.book, 'Serena', 'cpu', 'after')
        self.segments = self.library.rows('SELECT * FROM segments ORDER BY position')

    def tearDown(self):
        self.library.db.close()
        self.temp.cleanup()

    def commit(self, segment, samples):
        self.library.segment_path(segment, True).write_bytes(b'\x01\x00' * samples)
        self.library.commit_segment(segment, samples)

    def test_utf16_exact_source_and_existing_job(self):
        index = self.library.reader(self.job)
        self.assertEqual(index['samples'], 0)
        for s in index['segments']:
            source = self.library.reader(self.job, chapter=s['chapter'])['text'].encode('utf-16-le')
            self.assertEqual(source[s['start'] * 2:s['end'] * 2].decode('utf-16-le'), self.segments[s['position']]['text'])
        self.assertTrue(all(s['sampleStart'] is None for s in index['segments']))
        new_book = self.library.add_book('新版', [{'title': 'changed', 'text': 'changed'}])
        self.assertNotEqual(new_book, self.book)
        self.assertEqual(self.library.reader(self.job, 0)['text'], self.text)

    def test_contiguous_timing_partial_write_and_gap(self):
        self.commit(self.segments[0], 24)
        second = self.segments[1]
        self.library.segment_path(second, True).write_bytes(b'\x02\x00' * 12)
        self.library.execute("UPDATE segments SET status='running',samples=12 WHERE id=?", (second['id'],))
        self.commit(self.segments[-1], 99)  # Deliberate hole: must not advertise this audio.
        index = self.library.reader(self.job)
        self.assertEqual(index['samples'], 36)
        self.assertEqual(index['segments'][1]['sampleStart'], 24)
        self.assertEqual(index['segments'][1]['sampleEnd'], 36)
        self.assertIsNone(index['segments'][-1]['sampleStart'])
        self.assertEqual(self.library.snapshot()['jobs'][0]['samples'], 36)
        self.assertEqual(len(self.library.audio(self.job, 0, 1000)), 72)
        update = self.library.reader(self.job, start=1, limit=1)
        self.assertEqual(update['segments'], index['segments'][1:2])
        self.assertNotIn('chapters', update)
        self.library.execute("UPDATE segments SET status='pending',samples=0 WHERE id=?", (second['id'],))
        self.assertEqual(self.library.reader(self.job)['samples'], 24)

    def test_zero_length_audio_and_cross_chapter_offsets(self):
        for s in self.segments:
            self.commit(s, 10 if s['text'].strip() else 0)
        index = self.library.reader(self.job)
        previous = 0
        for s in index['segments']:
            self.assertEqual(s['sampleStart'], previous)
            previous = s['sampleEnd']
        self.assertEqual(index['samples'], previous)
        self.assertEqual(index['segments'][-1]['start'], 0)
        self.assertEqual(index['completed'], index['total'])

    def test_invalid_ranges(self):
        for chapter in (-1, 9):
            with self.assertRaises(ValueError): self.library.reader(self.job, chapter)
        with self.assertRaises(ValueError): self.library.reader(self.job, start=-1, limit=2)
        with self.assertRaises(ValueError): self.library.reader('missing')


if __name__ == '__main__': unittest.main()
