"""A local stand-in for the Telegram Bot API: records sendMessage calls."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading


class FakeTelegram:
    def __init__(self, status=200):
        self.status = status
        self.calls = []   # (path, json body)
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                fake.calls.append((self.path, json.loads(body)))
                self.send_response(fake.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok": true}' if fake.status == 200 else b'{"ok": false}')

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def texts(self):
        return [body["text"] for _, body in self.calls]

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
