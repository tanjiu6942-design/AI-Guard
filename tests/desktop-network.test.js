import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { proxyFetch } from "../desktop/network.mjs";
import { longConnProbe } from "../desktop/probes.mjs";

async function withServer(handler, run) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(server.address().port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  }
}
describe("desktop network probe deadlines", () => {
  it('records whether failure happened before CONNECT completed', async () => {
    await withServer(s => s.once('data', () => s.end('HTTP/1.1 403 Forbidden\r\n\r\n')),
      port => expect(proxyFetch(port, 'https://www.cloudflare.com/', 500)).rejects.toThrow('[CONNECT]'));
  });
  it("sends proxy credentials on CONNECT using the explicit HTTPS target port", async () => {
    let received = "";
    const authorization = `Basic ${Buffer.from("aiguard-health:probe-secret").toString("base64")}`;
    await withServer(
      (socket) => socket.once("data", (chunk) => {
        received = chunk.toString();
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      }),
      (port) => expect(proxyFetch(port, "https://localhost:18443/", 500, authorization)).rejects.toThrow("403"),
    );
    expect(received).toMatch(/^CONNECT localhost:18443 HTTP\/1\.1\r\n/);
    expect(received.toLowerCase()).toContain(`proxy-authorization: ${authorization.toLowerCase()}\r\n`);
  });
  it("does not invent credentials for ordinary proxy calls", async () => {
    let received = "";
    await withServer(
      (socket) => socket.once("data", (chunk) => {
        received = chunk.toString();
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      }),
      (port) => expect(proxyFetch(port, "https://www.cloudflare.com/", 500)).rejects.toThrow("407"),
    );
    expect(received).not.toMatch(/proxy-authorization/i);
  });
  it("authenticates long-connection CONNECT on the supplied probe listener", async () => {
    let received = "";
    const authorization = `Basic ${Buffer.from("aiguard-health:long-secret").toString("base64")}`;
    await withServer(
      (socket) => socket.once("data", (chunk) => {
        received = chunk.toString();
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      }),
      async (port) => {
        expect((await longConnProbe(port, 50, 500, authorization)()).closed).toBe(true);
      },
    );
    expect(received).toContain(`Proxy-Authorization: ${authorization}\r\n`);
  });
  it("fails closed on rejected CONNECT", async () =>
    withServer(
      (s) => s.once("data", () => s.end("HTTP/1.1 403 Forbidden\r\n\r\n")),
      async (port) => {
        await expect(
          proxyFetch(port, "https://www.cloudflare.com/", 500),
        ).rejects.toThrow("403");
      },
    ));
  it("times out a stalled proxy request", async () =>
    withServer(
      () => {},
      async (port) => {
        await expect(
          proxyFetch(port, "https://www.cloudflare.com/", 60),
        ).rejects.toThrow("超时");
      },
    ));
  it("long-connection probe returns on a proxy that never answers CONNECT", async () =>
    withServer(
      () => {},
      async (port) => {
        const result = await Promise.race([
          longConnProbe(port, 100, 80)(),
          new Promise((r) => setTimeout(() => r("hung"), 400)),
        ]);
        expect(result).not.toBe("hung");
        expect(result.closed).toBe(true);
      },
    ));
});
