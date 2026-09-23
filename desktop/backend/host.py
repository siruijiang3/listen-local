"""Authenticated loopback API; emits a single startup record for the Tauri host."""
import argparse
import json
import os
import secrets
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from service import Service
from sharing import serve_file


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', required=True)
    args = parser.parse_args()
    # Held for the process lifetime; a second app must not recover live jobs.
    home = Path(args.home)
    home.mkdir(parents=True, exist_ok=True)
    instance_lock = (home / 'instance.lock').open('a+b')
    instance_lock.seek(0)
    if os.name == 'nt':
        import msvcrt
        try:
            msvcrt.locking(instance_lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise SystemExit('Listen Local is already running. Open it from the tray.')
    service = Service(args.home)
    token = secrets.token_urlsafe(32)
    origins = {'http://localhost:1420', 'http://127.0.0.1:1420', 'http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def authorized(self):
            supplied = self.headers.get('Authorization', '').removeprefix('Bearer ')
            if not secrets.compare_digest(supplied, token):
                self.send_error(403)
                return False
            origin = self.headers.get('Origin')
            if origin and origin not in origins:
                self.send_error(403)
                return False
            return True

        def end_headers(self):
            origin = self.headers.get('Origin')
            if origin in origins:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            super().end_headers()

        def do_OPTIONS(self):
            if self.headers.get('Origin') not in origins:
                self.send_error(403)
                return
            self.send_response(204)
            self.send_header('Access-Control-Allow-Methods', 'GET, POST')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.end_headers()

        def reply(self, data, status=200):
            encoded = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            if not self.authorized():
                return
            try:
                url = urlsplit(self.path)
                query = parse_qs(url.query)
                if url.path == '/v1/state':
                    self.reply(service.state())
                elif url.path == '/v1/audio':
                    pcm = service.library.audio(query['job'][0], int(query.get('offset', ['0'])[0]), int(query.get('count', ['48000'])[0]))
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(len(pcm)))
                    self.end_headers()
                    self.wfile.write(pcm)
                else:
                    self.send_error(404)
            except Exception as error:
                self.reply({'error': str(error)}, 400)

        def do_POST(self):
            if not self.authorized():
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length > 30 * 1024 * 1024 or length < 0:
                    raise ValueError('请求过大。')
                body = json.loads(self.rfile.read(length) or '{}')
                action = self.path.removeprefix('/v1/')
                if not self.path.startswith('/v1/'):
                    self.send_error(404)
                elif action == 'shutdown':
                    self.reply({})
                    threading.Thread(target=server.shutdown, daemon=True).start()
                else:
                    self.reply(service.action(action, body))
            except Exception as error:
                self.reply({'error': str(error)}, 400)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    print(json.dumps({'protocol': 1, 'port': server.server_port, 'token': token}), flush=True)
    try:
        server.serve_forever()
    finally:
        service.close()
        server.server_close()


if __name__ == '__main__':
    main()
