import { connect } from "node:net";
const pipe = process.argv[process.argv.indexOf("--aiguard-worker") + 1];
setTimeout(() => {
  const socket = connect(pipe);
  let buffer = "";
  socket.on("error", () => process.exit(0));
  socket.on("close", () => process.exit(0));
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (let nl; (nl = buffer.indexOf("\n")) >= 0;) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (msg.method === 'start' && msg.payload?.fixtureProtection)
        socket.write(JSON.stringify({ event: 'protection', value: { phase: 'healthy' } }) + '\n');
      socket.write(
        JSON.stringify({ id: msg.id, result: { pid: process.pid } }) + "\n",
      );
    }
  });
}, 100);
