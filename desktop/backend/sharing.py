"""Opt-in, capability-protected LAN downloads. No library or engine APIs here."""
import base64
import html
import io
import mimetypes
import re
import secrets
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit


def serve_file(handler, path, name, etag=None):
    path = Path(path)
    total = path.stat().st_size
    start, end, status = 0, total-1, 200
    requested = handler.headers.get('Range')
    if requested and (not handler.headers.get('If-Range') or handler.headers['If-Range'] == f'"{etag}"'):
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
        try:
            if not match or not any(match.groups()):
                raise ValueError()
            left, right = match.groups()
            if left:
                start = int(left)
                end = min(int(right), total-1) if right else total-1
            else:
                length = int(right)
                if length <= 0:
                    raise ValueError()
                start = max(0, total-length)
            if start > end or start >= total:
                raise ValueError()
            status = 206
        except ValueError:
            handler.send_response(416)
            handler.send_header('Content-Range', f'bytes */{total}')
            handler.send_header('Content-Length', '0')
            handler.end_headers()
            return
    handler.send_response(status)
    handler.send_header('Content-Type', mimetypes.guess_type(name)[0] or 'application/octet-stream')
    handler.send_header('Content-Disposition', "attachment; filename*=UTF-8''" + quote(name, safe=''))
    handler.send_header('Accept-Ranges', 'bytes')
    handler.send_header('Content-Length', str(max(0, end-start+1)))
    handler.send_header('Cache-Control', 'private, no-store')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    if etag:
        handler.send_header('ETag', f'"{etag}"')
    if status == 206:
        handler.send_header('Content-Range', f'bytes {start}-{end}/{total}')
    handler.end_headers()
    if handler.command == 'HEAD':
        return
    with path.open('rb') as stream:
        stream.seek(start)
        remaining = end-start+1
        while remaining > 0:
            chunk = stream.read(min(remaining, 128*1024))
            if not chunk:
                break
            handler.wfile.write(chunk)
            remaining -= len(chunk)


class Share:
    def __init__(self, records, title):
        self.token = secrets.token_urlsafe(32)
        self.records = {r['id']: r for r in records}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass  # Do not write access tokens to logs.

            def do_HEAD(self):
                self.do_GET()

            def do_GET(self):
                parts = urlsplit(self.path).path.strip('/').split('/')
                if len(parts) < 2 or parts[0] != 'share' or not secrets.compare_digest(parts[1], owner.token):
                    self.send_error(404)
                    return
                if len(parts) == 3 and parts[2] in owner.records:
                    record = owner.records[parts[2]]
                    try:
                        serve_file(self, record['path'], record['name'], record['sha256'])
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                elif len(parts) == 2:
                    links = ''.join(f'<li><a href="/share/{owner.token}/{r["id"]}">{html.escape(r["name"])}</a><small>{r["bytes"]/1048576:.1f} MB</small></li>' for r in owner.records.values())
                    page = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title><style>body{{max-width:640px;margin:40px auto;padding:20px;font:18px system-ui;background:#f7f4ed;color:#24342d}}li{{margin:24px 0}}a{{color:#166249}}small{{display:block;color:#777;margin-top:6px}}</style><h1>{html.escape(title)}</h1><p>下载到手机后，使用有声书或音乐播放器打开。保存完成后可以断网收听。</p><p>M4B 保留章节；播放器不支持时选择 MP3。</p><ul>{links}</ul></html>'''.encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html; charset=utf-8')
                    self.send_header('Content-Length', str(len(page)))
                    self.send_header('Referrer-Policy', 'no-referrer')
                    self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
                    self.end_headers()
                    if self.command != 'HEAD':
                        self.wfile.write(page)
                else:
                    self.send_error(404)

        self.server = ThreadingHTTPServer(('0.0.0.0', 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.connect(('192.0.2.1', 9))
                host = sock.getsockname()[0]
        except OSError:
            host = socket.gethostbyname(socket.gethostname())
        self.url = f'http://{host}:{self.server.server_port}/share/{self.token}'

    def info(self):
        import qrcode
        from qrcode.image.svg import SvgPathImage
        image = qrcode.make(self.url, image_factory=SvgPathImage)
        buffer = io.BytesIO()
        image.save(buffer)
        return {'url': self.url, 'qr': 'data:image/svg+xml;base64,' + base64.b64encode(buffer.getvalue()).decode()}

    def close(self):
        self.server.shutdown()
        self.server.server_close()
