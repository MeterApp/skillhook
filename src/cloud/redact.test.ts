import { describe, expect, it } from "vitest";
import { capText, REDACTED, redactUpload, scrubSecrets, secretValues } from "./redact.js";

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
});
