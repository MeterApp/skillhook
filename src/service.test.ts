import { describe, expect, it } from "vitest";
import { renderLaunchdPlist, renderSystemdUnit, serviceSpec } from "./service.js";
import { tempHome } from "./test-support/helpers.js";

describe("service files", () => {
  it("renders a launchd plist pointing at node, the CLI and the home dir", () => {
    const paths = tempHome();
    const spec = serviceSpec(paths);
    const plist = renderLaunchdPlist(spec);
    expect(plist).toContain("<string>co.meterapp.skillhook</string>");
    expect(plist).toContain(`<string>${spec.node}</string>`);
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain(`<string>${paths.home}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/opt/homebrew/bin");
    expect(plist).toContain("service.log");
  });

  it("renders a systemd unit", () => {
    const paths = tempHome();
    const spec = serviceSpec(paths);
    const unit = renderSystemdUnit(spec);
    expect(unit).toContain(`ExecStart=${spec.node}`);
    expect(unit).toContain(`serve --dir ${paths.home}`);
    expect(unit).toContain("Restart=always");
  });
});

describe("stableNodePath", () => {
  it("keeps non-Homebrew paths and only swaps Cellar paths for a matching symlink", async () => {
    const { stableNodePath } = await import("./service.js");
    expect(stableNodePath("/usr/local/bin/node")).toBe("/usr/local/bin/node");
    expect(stableNodePath("/Users/x/.nvm/versions/node/v24.0.0/bin/node")).toBe("/Users/x/.nvm/versions/node/v24.0.0/bin/node");
    const cellar = "/opt/homebrew/Cellar/node/99.0.0/bin/node";
    expect(["/opt/homebrew/bin/node", "/usr/local/bin/node", cellar]).toContain(stableNodePath(cellar));
  });
});
