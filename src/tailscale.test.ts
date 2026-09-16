import { describe, expect, it } from "vitest";
import { parseServeConfig, parseTailscaleStatus } from "./tailscale.js";

describe("tailscale parsing", () => {
  it("extracts self info from status --json", () => {
    const self = parseTailscaleStatus({ BackendState: "Running", Self: { HostName: "mbp", DNSName: "mbp.tail1234.ts.net.", Online: true, TailscaleIPs: ["100.1.2.3"] }, CurrentTailnet: { Name: "jonathan@" } });
    expect(self).toMatchObject({ backendState: "Running", dnsName: "mbp.tail1234.ts.net", online: true, tailnet: "jonathan@" });
    expect(parseTailscaleStatus(null)).toBeUndefined();
  });

  it("maps a ServeConfig to funnel/serve URLs", () => {
    const exposures = parseServeConfig({
      TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
      Web: {
        "mbp.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } },
        "mbp.tail1234.ts.net:8443": { Handlers: { "/app": { Proxy: "http://127.0.0.1:3000" } } },
      },
      AllowFunnel: { "mbp.tail1234.ts.net:443": true },
    });
    expect(exposures).toEqual([
      { url: "https://mbp.tail1234.ts.net", target: "http://127.0.0.1:8787", mode: "funnel", port: 443, path: "/" },
      { url: "https://mbp.tail1234.ts.net:8443/app", target: "http://127.0.0.1:3000", mode: "serve", port: 8443, path: "/app" },
    ]);
    expect(parseServeConfig({})).toEqual([]);
  });
});
