// Runs inside the sandbox (PIP-158): listens on 127.0.0.1 and forwards every connection to the proxy's unix
// socket. Usage: proxy-bridge.ts <socket> <port> <ready-file>; the file is created once it listens.

import { writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";

const [socket, portText, ready] = process.argv.slice(2);
if (!socket || !portText || !ready) {
  process.stderr.write("usage: proxy-bridge.ts <socket> <port> <ready-file>\n");
  process.exit(2);
}

const server = createServer((c) => {
  const up = connect(socket);
  c.pipe(up);
  up.pipe(c);
  const end = () => {
    c.destroy();
    up.destroy();
  };
  c.on("error", end);
  up.on("error", end);
});

server.listen(Number(portText), "127.0.0.1", () => writeFileSync(ready, "ready"));
