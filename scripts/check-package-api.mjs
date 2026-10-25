#!/usr/bin/env node
// Validate public library exports and declarations from the packed artifact.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "skillhook-library-consumer-"));
const run = (command, args, cwd = work) => execFileSync(command, args, { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SKILLHOOK_NO_UPDATE_CHECK: "1" } });
try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", work], root));
  const [info] = Object.values(packed);
  writeFileSync(join(work, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(work, info.filename), `@types/node@${manifest.devDependencies["@types/node"]}`]);
  writeFileSync(join(work, "consumer.mjs"), `
import assert from "node:assert/strict";
import { VERSION, adminRequest, probeServer, protocol } from "@meterapp/skillhook";
import { PROTOCOL_VERSION, CommandErrorSchema } from "@meterapp/skillhook/protocol";
assert.equal(VERSION, ${JSON.stringify(manifest.version)});
assert.equal(PROTOCOL_VERSION, protocol.PROTOCOL_VERSION);
assert.ok(CommandErrorSchema.safeParse({ code: "denied_by_policy", message: "fake" }).success);
const original = globalThis.fetch;
let calls = 0;
try {
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://example.test/jobs");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fake-admin-token");
    return Response.json({ jobs: [] });
  };
  const result = await adminRequest("https://example.test", { SKILLHOOK_ADMIN_TOKEN: "fake-admin-token" }, "/jobs");
  assert.equal(result.status, 200); assert.deepEqual(result.body, { jobs: [] }); assert.equal(calls, 1);
  globalThis.fetch = async () => Response.json({ ok: true, version: VERSION });
  assert.equal((await probeServer("https://example.test")).version, VERSION);
} finally { globalThis.fetch = original; }
`);
  run(process.execPath, [join(work, "consumer.mjs")]);
  writeFileSync(join(work, "consumer.ts"), `
import { adminRequest, probeServer, type HealthResponse } from "@meterapp/skillhook";
import { PROTOCOL_VERSION, CommandErrorSchema, type CommandErrorCode } from "@meterapp/skillhook/protocol";
const health: Promise<HealthResponse | undefined> = probeServer("https://example.test");
const error: CommandErrorCode = CommandErrorSchema.parse({code:"denied_by_policy",message:"fake"}).code;
void [health, error, adminRequest, PROTOCOL_VERSION];
`);
  const compiler = join(root, "node_modules/typescript");
  const compilerManifest = JSON.parse(readFileSync(join(compiler, "package.json"), "utf8"));
  run(process.execPath, [join(compiler, Object.values(compilerManifest.bin)[0]), "--strict", "--noEmit", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--types", "node", "consumer.ts"]);
  console.log(`Packed ${manifest.name}@${manifest.version}: root/protocol imports, mock admin auth, health and strict consumer types passed.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
