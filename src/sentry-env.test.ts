import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { isSkillhookCredential } from "./env.js";
import { baseRunEnv, buildRunEnv } from "./runners/env.js";
import { parseSkillDocument } from "./skills.js";

const daemonVariables = {
  SKILLHOOK_SENTRY_DSN: "https://private-key@example.invalid/1",
  SKILLHOOK_SENTRY_ENVIRONMENT: "production",
  SKILLHOOK_SENTRY_FUTURE_SETTING: "private-value",
  SKILLHOOK_NO_SENTRY: "1",
};

describe("daemon Sentry environment isolation", () => {
  it.each(Object.keys(daemonVariables))("reserves %s as a daemon-owned credential or privacy control", (name) => {
    expect(isSkillhookCredential(name)).toBe(true);
    expect(() => parseSkillDocument(`---\nname: demo\ndescription: demo\nskillhook:\n  auth:\n    type: bearer\n    secret_env: ${name}\n---\nbody`, "/skills/demo")).toThrow();
  });

  it("does not classify a skill's ordinary secret as a daemon credential", () => {
    expect(isSkillhookCredential("SKILLHOOK_SECRET_DEMO")).toBe(false);
    expect(isSkillhookCredential("MY_SENTRY_DSN")).toBe(false);
  });

  it("keeps daemon Sentry settings out of runner/probe defaults from both env sources", () => {
    const env = baseRunEnv({ secrets: daemonVariables, fileSecrets: daemonVariables, processEnv: { PATH: "/bin", ...daemonVariables } });
    for (const name of Object.keys(daemonVariables)) expect(env).not.toHaveProperty(name);
  });

  it.each(["skill", "config", "both"])("cannot explicitly forward daemon Sentry settings via %s passthrough", (source) => {
    const names = Object.keys(daemonVariables);
    const config = defaultConfig();
    if (source !== "skill") config.env_passthrough.push(...names, "MY_SENTRY_DSN");
    const frontmatter = source === "config" ? "" : `skillhook:\n  env: [${[...names, "MY_SENTRY_DSN"].join(", ")}]\n`;
    const skill = parseSkillDocument(`---\nname: demo\ndescription: demo\n${frontmatter}---\nbody`, "/skills/demo");
    const secrets = { ...daemonVariables, MY_SENTRY_DSN: "https://own-app@example.invalid/2" };
    const env = buildRunEnv({ skill, config, secrets, fileSecrets: secrets, processEnv: { PATH: "/bin", ...daemonVariables }, jobVars: { SKILLHOOK_JOB_ID: "job-1" } });
    for (const name of names) expect(env).not.toHaveProperty(name);
    expect(env.MY_SENTRY_DSN).toBe(secrets.MY_SENTRY_DSN);
    expect(env.SKILLHOOK_JOB_ID).toBe("job-1");
  });
});
