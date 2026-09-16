import { describe, expect, it } from "vitest";
import { buildPrompt, renderTemplate } from "./prompt.js";
import { parseSkillDocument } from "./skills.js";
import type { WebhookEvent } from "./payload.js";

function event(payload: unknown): WebhookEvent {
  return { id: "j1", skill: "demo", trigger: "webhook", received_at: "2026-09-15T00:00:00.000Z", method: "POST", path: "/hooks/demo", query: { env: "prod" }, headers: { "x-github-event": "issues", "content-type": "application/json" }, source_ip: "1.2.3.4", content_type: "application/json", content_length: 10, body_kind: "json", delivery_id: "d1", payload };
}

function input(body: string, payload: unknown, inlineMaxBytes = 200_000) {
  const skill = parseSkillDocument(`---\nname: demo\ndescription: d\n---\n${body}`, "/skills/demo");
  return { skill, event: event(payload), jobId: "j1", jobDir: "/jobs/j1", payloadPath: "/jobs/j1/payload.json", eventPath: "/jobs/j1/event.json", inlineMaxBytes };
}

describe("renderTemplate", () => {
  it("substitutes simple, nested payload, header and query placeholders", () => {
    const { text, used } = renderTemplate("id={{job_id}} lvl={{payload.data.level}} ev={{headers.X-GitHub-Event}} q={{query.env}} obj={{payload.data}} none={{payload.nope}}", { job_id: "j1", query: { env: "prod" } }, { data: { level: "error" } }, { "x-github-event": "issues" });
    expect(text).toBe('id=j1 lvl=error ev=issues q=prod obj={\n  "level": "error"\n} none=');
    expect(used).toContain("payload.data.level");
  });
});

describe("buildPrompt", () => {
  it("appends the event block when the body does not reference the payload", () => {
    const built = buildPrompt(input("# Demo\nHandle it.", { a: 1 }));
    expect(built.appendedEvent).toBe(true);
    expect(built.prompt).toContain("# Skill: demo");
    expect(built.prompt).toContain("<webhook_payload>\n{\n  \"a\": 1\n}\n</webhook_payload>");
    expect(built.prompt).toContain("delivery_id: d1");
    expect(built.guardrails).toContain('"demo" skill');
    expect(built.guardrails).toContain("/jobs/j1/payload.json");
  });

  it("does not append when the body places the payload itself", () => {
    const built = buildPrompt(input("Level: {{payload.data.level}}\n\n{{payload}}", { data: { level: "warn" } }));
    expect(built.appendedEvent).toBe(false);
    expect(built.prompt).toContain("Level: warn");
    expect(built.prompt).toContain('"level": "warn"');
    expect(built.prompt).not.toContain("<webhook_headers>");
  });

  it("truncates huge payloads inline and points at the file", () => {
    const built = buildPrompt(input("Go.", { big: "x".repeat(5000) }, 1000));
    expect(built.prompt).toContain("payload truncated");
    expect(built.prompt).toContain("/jobs/j1/payload.json");
    expect(built.prompt.length).toBeLessThan(3000);
  });
});
