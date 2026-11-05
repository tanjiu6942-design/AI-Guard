import { request } from "node:http";
import { request as httpsRequest, Agent } from "node:https";
import { connect } from "node:tls";

// CONNECT only; never fall back to a direct connection on proxy failure.
export function proxyFetch(port, url, timeout = 12000, proxyAuthorization) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:")
      return reject(Error("Only HTTPS probe targets are supported"));
    let tunnel, responseRequest;
    const agent = new Agent({ keepAlive: false });
    const finish = (err, result) => {
      clearTimeout(timer);
      agent.destroy();
      tunnel?.destroy();
      err ? reject(err) : resolve(result);
    };
    const timer = setTimeout(() => {
      req.destroy();
      responseRequest?.destroy();
      finish(Error("代理探测超时"));
    }, timeout);
    const req = request({
      host: "127.0.0.1",
      port,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: {
        Host: `${target.hostname}:${target.port || 443}`,
        ...(proxyAuthorization ? { "Proxy-Authorization": proxyAuthorization } : {}),
      },
    });
    req.on("error", (e) => finish(e));
    req.on("connect", (res, socket, head) => {
      tunnel = socket;
      if (res.statusCode !== 200)
        return finish(Error(`CONNECT HTTP ${res.statusCode}`));
      if (head.length) socket.unshift(head);
      agent.createConnection = () =>
        connect({
          socket,
          servername: target.hostname,
          rejectUnauthorized: true,
        });
      responseRequest = httpsRequest(
        target,
        {
          agent,
          headers: { "user-agent": "AI-Guard/0.1", connection: "close" },
        },
        (r) => {
          const chunks = [];
          r.on("data", (chunk) => chunks.push(chunk));
          r.on("error", (e) => finish(e));
          r.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            finish(null, {
              ok: r.statusCode >= 200 && r.statusCode < 300,
              status: r.statusCode,
              text: async () => body,
              json: async () => JSON.parse(body),
            });
          });
        },
      );
      responseRequest.on("error", (e) => finish(e));
      responseRequest.end();
    });
    req.end();
  });
}
