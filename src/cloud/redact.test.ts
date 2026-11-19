import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountViewForUpload, capText, maskEmails, REDACTED, redactUpload, scrubAssignments, scrubSecrets, scrubValues, secretValues } from "./redact.js";

// Placeholder values only: nothing here resembles a real credential format.
const FAKE_ENV = {
  SKILLHOOK_SECRET_HELLO: "placeholder-hello-value",
  QUOTED_VALUE: 'placeholder "quoted"\nline',
  TINY: "abc",
};

describe("redaction for uploads", () => {
  it("replaces every .env value in every string, raw or JSON-escaped, and ignores values too short to matter", () => {
    expect(secretValues(FAKE_ENV)).toEqual(['placeholder "quoted"\nline', "placeholder-hello-value"]);
    const input = {
      result: "Used placeholder-hello-value to call the API",
      nested: [{ log: 'saw {"v":"placeholder \\"quoted\\"\\nline"} in the payload' }],
      short: "abc stays",
      count: 3,
      flag: true,
      none: null,
    };
    const scrubbed = scrubSecrets(input, FAKE_ENV);
    expect(scrubbed.result).toBe(`Used ${REDACTED} to call the API`);
    expect(scrubbed.nested[0]?.log).toBe(`saw {"v":"${REDACTED}"} in the payload`);
    expect(scrubbed.short).toBe("abc stays");
    expect(scrubbed.count).toBe(3);
    expect(scrubbed.flag).toBe(true);
    expect(scrubbed.none).toBeNull();
    expect(input.result).toContain("placeholder-hello-value"); // the original is untouched
    expect(scrubSecrets("nothing to hide", {})).toBe("nothing to hide");
    expect(JSON.stringify(scrubSecrets(input, FAKE_ENV))).not.toContain("placeholder-hello-value");
  });

  it("preserves explicitly public repo links while keeping unknown and overlapping secrets private", () => {
    const env = { METER_REPO_SLUG: "ExampleOrg/example-repo", UNKNOWN_VALUE: "placeholder-private-value" };
    const url = "https://github.com/ExampleOrg/example-repo/pull/16223";
    expect(scrubSecrets(url, env)).toBe("https://github.com/[redacted]/pull/16223");
    const values = secretValues(env, ["METER_REPO_SLUG"]);
    expect(scrubSecrets({ links: [{ url }], summary: env.UNKNOWN_VALUE }, values))
      .toEqual({ links: [{ url }], summary: REDACTED });
    expect(secretValues({ ...env, API_TOKEN: env.METER_REPO_SLUG }, ["METER_REPO_SLUG", "API_TOKEN"]))
      .toContain(env.METER_REPO_SLUG);
    expect(secretValues({ SKILLHOOK_SECRET_HELLO: "placeholder-credential" }, ["SKILLHOOK_SECRET_HELLO"]))
      .toEqual(["placeholder-credential"]);
  });

  it("drops command lines and environments and redacts headers wherever they appear", () => {
    const job = {
      id: "j1",
      command: ["claude", "-p"],
      resume_command: "cd /x && claude --resume s1",
      source: { ip: "203.0.113.9", headers: { authorization: "Bearer placeholder", "x-hub-signature-256": "sha256=placeholder", "content-type": "application/json" } },
      runs: [{ env: { A: "1" }, argv: ["x"], stdin: "data", ok: true }],
    };
    const redacted = redactUpload(job) as Record<string, unknown>;
    expect(redacted.command).toBeUndefined();
    expect(redacted.resume_command).toBeUndefined();
    const headers = (redacted.source as { headers: Record<string, string> }).headers;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).not.toBe("Bearer placeholder");
    expect(headers["x-hub-signature-256"]).not.toBe("sha256=placeholder");
    expect((redacted.runs as Record<string, unknown>[])[0]).toEqual({ ok: true });
    expect(job.command).toEqual(["claude", "-p"]);
  });

  it("caps text on a character boundary", () => {
    expect(capText("short", 100)).toEqual({ text: "short", truncated: false, bytes: 5 });
    const capped = capText("ééééé", 5); // 10 bytes of UTF-8
    expect(capped).toEqual({ text: "éé", truncated: true, bytes: 10 });
  });

  it("masks email addresses to their first letter and domain, and leaves other @ alone", () => {
    expect(maskEmails("logged in as ada.lovelace+work@mail.example.com, Ada's Org")).toBe("logged in as a…@mail.example.com, Ada's Org");
    expect(maskEmails("a@b.co and bob@example.org.")).toBe("a…@b.co and b…@example.org.");
    expect(maskEmails("@scope/pkg, user@localhost, @@, trailing@")).toBe("@scope/pkg, user@localhost, @@, trailing@");
    expect(maskEmails("x".repeat(50_000) + "@" + "y".repeat(50_000))).toHaveLength(100_001);
  });

  it("keeps an account's view to its allow-list: no directory, no paths, no unknown fields", () => {
    const view = accountViewForUpload({ name: "work", runner: "claude", kind: "login", dir: "/Users/ada/.claude", default_dir: true, status: "ready", extra: "x", identity: { email: "ada@example.com", plan: "max", checked_at: "t", secret: "s" }, attention: [{ level: "warn", code: "usage_high", message: "usage high", internal: 1 }], readiness: { runner: "claude", path: "/bin/claude", config_dir: "/Users/ada/.claude", ready: true, detail: "ok" } });
    expect(view).toEqual({ name: "work", runner: "claude", kind: "login", default_dir: true, status: "ready", identity: { email: "a…@example.com", plan: "max", checked_at: "t" }, attention: [{ level: "warn", code: "usage_high", message: "usage high" }], readiness: { runner: "claude", ready: true, detail: "ok" } });
  });
});

describe("a printed environment", () => {
  it("blanks the value of every credential-looking assignment, known to the machine or not", () => {
    const dump = ["HOME=/Users/ada", "TWILIO_AUTH_TOKEN=placeholder0123456789abcdef", "ASC_PRIVATE_KEY_B64=cGxhY2Vob2xkZXI9PQ==", "ASC_PRIVATE_KEY_PATH=/Users/ada/keys/asc.p8", "LANG=en_US.UTF-8", "STITCH_API_KEY=placeholder-stitch-value"].join("\n");
    const out = scrubSecrets(dump, {});
    expect(out).toContain("HOME=/Users/ada");
    expect(out).toContain("LANG=en_US.UTF-8");
    expect(out).toContain("ASC_PRIVATE_KEY_PATH=/Users/ada/keys/asc.p8");
    expect(out).toContain(`TWILIO_AUTH_TOKEN=${REDACTED}`);
    expect(out).toContain(`ASC_PRIVATE_KEY_B64=${REDACTED}`);
    expect(out).toContain(`STITCH_API_KEY=${REDACTED}`);
    expect(out).not.toContain("placeholder");
  });

  it("handles quoted and JSON-escaped dumps, as a runner's stream-json transcript holds them", () => {
    expect(scrubAssignments(`declare -x SENTRY_AUTH_TOKEN="placeholder-sentry-value"`)).toBe(`declare -x SENTRY_AUTH_TOKEN="${REDACTED}"`);
    const line = JSON.stringify({ content: `export CROWDIN_API_TOKEN='placeholder-crowdin'\nMESHY_API_KEY="placeholder-meshy-1"\nUSER=ada` });
    const out = scrubAssignments(line);
    expect(out).not.toContain("placeholder");
    expect(JSON.parse(out).content).toContain("USER=ada");
  });

  it("leaves references, placeholders, short values and ordinary code alone", () => {
    for (const text of ["API_KEY=$OTHER_KEY", "GH_TOKEN=<your token>", 'SECRET_KEY="${VAULT}"', "MAX_KEY=12", "const apiKey=computeKey()", "SKILLHOOK_JOB_ID=20261118T070516Z-6c835k", `X_TOKEN=${REDACTED}`]) expect(scrubAssignments(text)).toBe(text);
  });

  it("scrubs the values of the files cloud.scrub_env_files names, whatever their names", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "skillhook-scrub-"));
    const file = path.join(dir, "shell.env");
    writeFileSync(file, "export REVENUE_CAT_MCP=placeholder-revenuecat-value\nSHORT=abc\n");
    const values = scrubValues({ SKILLHOOK_SECRET_HELLO: "placeholder-hello-value" }, { public_env: [], scrub_env_files: [file, path.join(dir, "missing.env")] });
    expect(scrubSecrets("curl -H placeholder-revenuecat-value and placeholder-hello-value abc", values)).toBe(`curl -H ${REDACTED} and ${REDACTED} abc`);
  });
});
