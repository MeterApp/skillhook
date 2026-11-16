import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useHttp1ForFetch } from "./http1.js";

// RA-020: the built-in fetch must not negotiate HTTP/2, whatever Node's bundled undici prefers.
// A throwaway self-signed certificate made at test time (nothing is committed); no openssl, no test.
function makeCert(): { dir: string; key: string; cert: string } | undefined {
  const dir = mkdtempSync(path.join(tmpdir(), "skillhook-http1-"));
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-days", "1", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")],
      { stdio: "ignore", timeout: 20_000 },
    );
    return { dir, key: readFileSync(path.join(dir, "key.pem"), "utf8"), cert: readFileSync(path.join(dir, "cert.pem"), "utf8") };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
}

const tlsFiles = makeCert();

describe.skipIf(!tlsFiles)("useHttp1ForFetch", () => {
  const { key, cert } = tlsFiles ?? { key: "", cert: "" };
  let server: http2.Http2SecureServer;
  let port = 0;
  const previous = getGlobalDispatcher();
  const sockets = new Set<tls.TLSSocket>();

  beforeAll(async () => {
    // Offers h2 and http/1.1 in ALPN, prefers h2, and answers with the HTTP version the request came in on.
    server = http2.createSecureServer({ key, cert, allowHTTP1: true }, (req, res) => {
      res.end(req.httpVersion);
    });
    server.on("secureConnection", (socket: tls.TLSSocket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    setGlobalDispatcher(previous);
    // Kept-alive connections (h2 sessions, HTTP/1.1 keep-alive) would hold close() open.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
    if (tlsFiles) rmSync(tlsFiles.dir, { recursive: true, force: true });
  });

  it("the test server negotiates h2 with a client that offers it", async () => {
    const protocol = await new Promise<string | false | null>((resolve, reject) => {
      const socket = tls.connect({ host: "127.0.0.1", port, ca: cert, servername: "localhost", ALPNProtocols: ["h2", "http/1.1"] }, () => {
        resolve(socket.alpnProtocol);
        socket.end();
      });
      socket.on("error", reject);
    });
    expect(protocol).toBe("h2");
  });

  it("the built-in fetch gets HTTP/2 from it when its dispatcher allows h2 (the control)", async () => {
    setGlobalDispatcher(new Agent({ connect: { ca: cert }, allowH2: true }));
    const response = await fetch(`https://127.0.0.1:${port}/`);
    expect(await response.text()).toBe("2.0");
  });

  it("makes the built-in fetch use HTTP/1.1", async () => {
    useHttp1ForFetch({ connect: { ca: cert } });
    const response = await fetch(`https://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("1.1");
  });
});
