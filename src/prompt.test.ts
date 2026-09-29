import { describe, expect, it } from "vitest";
import { buildPrompt, renderTemplate } from "./prompt.js";
import { parseSkillDocument } from "./skills.js";
import type { WebhookEvent } from "./payload.js";

function event(payload: unknown): WebhookEvent {
  return { id: "j1", skill: "demo", trigger: "webhook", received_at: "2026-09-15T00:00:00.000Z", method: "POST", path: "/hooks/demo", query: { env: "prod" }, headers: { "x-github-event": "issues", "content-type": "application/json" }, source_ip: "1.2.3.4", content_type: "application/json", content_length: 10, body_kind: "json", delivery_id: "d1", payload };
}

function input(body: string, payload: unknown, inlineMaxBytes = 200_000) {
  const skill = parseSkillDocument(`---\nname: demo\ndescription: d\n---\n${body}`, "/skills/demo");
  return { skill, event: event(payload), jobId: "j1", jobDir: "/jobs/j1", payloadPath: "/jobs/j1/payload.json", eventPath: "/jobs/j1/event.json", responsePath: "/jobs/j1/response.json", inlineMaxBytes };
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

  it("tells the agent how to report the outcome, per response.mode", () => {
    expect(buildPrompt(input("Go.", {})).guardrails).toContain("write /jobs/j1/response.json as JSON");
    expect(buildPrompt(input("Go.", {})).guardrails).toContain('"needs_human"');
    const structured = parseSkillDocument(`---\nname: demo\ndescription: d\nskillhook:\n  response:\n    mode: structured\n---\nGo.`, "/skills/demo");
    expect(buildPrompt({ ...input("Go.", {}), skill: structured }).guardrails).toContain("must be the JSON object the schema asks for");
    const file = parseSkillDocument(`---\nname: demo\ndescription: d\nskillhook:\n  response:\n    mode: file\n---\nGo.`, "/skills/demo");
    expect(buildPrompt({ ...input("Go.", {}), skill: file }).guardrails).toContain("Before you finish, write /jobs/j1/response.json");
    expect(renderTemplate("{{response_path}}", { response_path: "/r.json" }, {}).text).toBe("/r.json");
  });

  it("tells the agent how to report progress and ask a person, per agent_api", () => {
    const base = input("Go.", {});
    const mcp = buildPrompt(base).guardrails;
    expect(mcp).toContain("job_progress tool");
    expect(mcp).toContain("job_ask_human");
    expect(mcp).toContain("waits up to 5 min");
    expect(mcp).toContain("<human_answer>");
    expect(mcp).toContain("a person can only be reached through the job API");
    const cli = buildPrompt({ ...base, agentApi: "cli", bin: "/usr/bin/node /opt/cli.js", humanWaitSeconds: 1800 }).guardrails;
    expect(cli).toContain('`/usr/bin/node /opt/cli.js job progress "<what you are doing>"`');
    expect(cli).toContain("job ask");
    expect(cli).toContain("waits up to 30 min");
    expect(cli).not.toContain("job_progress");
    const none = buildPrompt({ ...base, agentApi: "none" }).guardrails;
    expect(none).toContain("nobody can answer questions");
    expect(none).not.toContain("job_progress");
    expect(none).not.toContain("job ask");
  });

  it("builds the prompt of a resumed run: the answer alone for a session, the whole skill plus the answer otherwise", () => {
    const base = input("Handle {{payload.a}}.", { a: 1 });
    const answer = { question_id: "q1", text: "Go with B", option: "B", by: "ada", at: "2026-09-28T12:00:00.000Z" };
    const question = { id: "q1", text: "A or B?", options: ["A", "B"], asked_at: "2026-09-28T11:59:00.000Z" };
    const resumed = buildPrompt({ ...base, event: { ...base.event, trigger: "resume" }, resume: { originalJob: "j0", question, answer, fresh: false } });
    expect(resumed.prompt).toContain("# Skill: demo (resumed)");
    expect(resumed.prompt).not.toContain("Handle 1.");
    expect(resumed.prompt).toContain("<human_question>\nA or B?\nOptions: A | B\n</human_question>");
    expect(resumed.prompt).toContain("<human_answer>\nB: Go with B\n(answered by ada)\n</human_answer>");
    expect(resumed.appendedEvent).toBe(false);
    expect(resumed.guardrails).toContain("continuing an earlier run because a person answered");
    expect(resumed.guardrails).toContain("do not redo work that is already done");
    const fresh = buildPrompt({ ...base, event: { ...base.event, trigger: "resume" }, resume: { originalJob: "j0", answer: { text: "do B", at: "2026-09-28T12:00:00.000Z" }, fresh: true } });
    expect(fresh.prompt).toContain("Handle 1.");
    expect(fresh.prompt).toContain("<human_answer>\ndo B\n</human_answer>");
    expect(fresh.prompt).not.toContain("<human_question>");
    expect(fresh.guardrails).toContain("that session could not be resumed");
  });

  it("describes a replay as such in the guardrails", () => {
    const base = input("Go.", {});
    const built = buildPrompt({ ...base, event: { ...base.event, trigger: "replay" } });
    expect(built.guardrails).toContain("replaying an earlier delivery");
    expect(built.prompt).toContain("- trigger: replay");
  });
});
