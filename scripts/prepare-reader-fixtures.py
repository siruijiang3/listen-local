"""Add UI-only fixture jobs to an ISOLATED copy of a validation library.

Reuses the first three PCM fragments with their actual source text. This is not
an inference benchmark. Never point this script at a user's library.
"""
import argparse
import json
import shutil
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'desktop/backend'))
from library import Library, uid

parser = argparse.ArgumentParser()
parser.add_argument('--isolated-library', required=True)
args = parser.parse_args()
library = Library(args.isolated_library)
try:
    source = library.one("SELECT job_id FROM segments GROUP BY job_id ORDER BY SUM(samples) DESC LIMIT 1")['job_id']
    original = library.rows('SELECT * FROM segments WHERE job_id=? ORDER BY position LIMIT 3', (source,))
    if len(original) != 3 or any(s['status'] != 'done' for s in original):
        raise ValueError('Three completed source fragments are required')
    for partial in (False, True):
        title = 'Reader fixture - ' + ('pending' if partial else 'chapters')
        if library.rows('SELECT id FROM books WHERE title=?', (title,)):
            raise ValueError('Fixture already exists; use another isolated copy')
        book = library.add_book(title, [
            {'title': 'First chapter', 'text': original[0]['text']},
            {'title': 'Second chapter', 'text': ''.join(s['text'] for s in original[1:])}])
        job = library.new_job(book, 'Serena', 'gpu', 'after')
        library.execute('DELETE FROM segments WHERE job_id=?', (job,))
        cursor = 0
        for position, old in enumerate(original):
            if position <= 1:
                cursor = 0
            segment_id = uid()
            done = not partial or position == 0
            library.execute('INSERT INTO segments(id,job_id,position,chapter,start,end,text,status,samples) VALUES(?,?,?,?,?,?,?,?,?)',
                (segment_id, job, position, min(position, 1), cursor, cursor + len(old['text']), old['text'],
                 'done' if done else 'pending', old['samples'] if done else 0))
            cursor += len(old['text'])
            if done:
                shutil.copy2(library.segment_path(old), library.root / 'audio' / job / (segment_id + '.pcm'))
        settings = json.loads(library.one('SELECT settings FROM jobs WHERE id=?', (job,))['settings'])
        settings['segmentation'] = 'legacy-ui-fixture'
        library.execute('UPDATE jobs SET status=?,settings=? WHERE id=?', ('paused' if partial else 'done', json.dumps(settings), job))
        print(title, job)
finally:
    library.db.close()
