"""A local stand-in for the Telegram Bot API: records sendMessage calls."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading


class FakeTelegram:
    def __init__(self, status=200):
        self.status = status
        self.calls = []   # (path, json body)
        self.queue = []   # pending getUpdates results
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                payload = json.loads(body)
                fake.calls.append((self.path, payload))
                self.send_response(fake.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                if fake.status != 200:
                    self.wfile.write(b'{"ok": false}')
                elif self.path.endswith("/getUpdates"):
                    offset = payload.get("offset") or 0
                    result = [u for u in fake.queue if u["update_id"] >= offset]
                    self.wfile.write(json.dumps({"ok": True, "result": result}).encode())
                else:
                    self.wfile.write(b'{"ok": true}')

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def push_update(self, chat_id, text):
        self.queue.append({"update_id": 100 + len(self.queue),
                           "message": {"chat": {"id": chat_id}, "text": text}})

    @property
    def texts(self):
        """Texts of sendMessage calls only."""
        return [body["text"] for path, body in self.calls if path.endswith("/sendMessage")]

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
