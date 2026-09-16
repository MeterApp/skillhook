import { readFileSync } from "node:fs";

/** Package name and version, read from package.json at runtime so `dist` and `src` agree. */
export const PACKAGE = (() => {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { name: string; version: string };
    return { name: pkg.name, version: pkg.version };
  } catch {
    return { name: "@meterapp/skillhook", version: "0.0.0" };
  }
})();

export const VERSION = PACKAGE.version;
