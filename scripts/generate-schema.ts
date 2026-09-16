// Writes schema/skillhook.schema.json (server config) and schema/skillhook.yaml.schema.json (a project's hooks)
// from the zod schemas.
//   npm run schema            regenerate
//   npm run schema -- --check fail when a committed file is stale (CI)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ConfigSchema } from "../src/config.js";
import { ProjectFileSchema } from "../src/projects.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = "https://raw.githubusercontent.com/MeterApp/skillhook/main/schema";

const schemas = [
  {
    file: "skillhook.schema.json",
    schema: {
      $id: `${base}/skillhook.schema.json`,
      title: "skillhook.json",
      description: "Server configuration for skillhook (https://github.com/MeterApp/skillhook).",
      ...z.toJSONSchema(ConfigSchema, { target: "draft-7", io: "input" }),
    },
  },
  {
    file: "skillhook.yaml.schema.json",
    schema: {
      $id: `${base}/skillhook.yaml.schema.json`,
      title: "skillhook.yaml",
      description: "Hooks a repository declares for skillhook (https://github.com/MeterApp/skillhook/blob/main/docs/projects.md): webhook name → shell command, SKILL.md or prompt.",
      ...z.toJSONSchema(ProjectFileSchema, { target: "draft-7", io: "input", unrepresentable: "any" }),
    },
  },
];

const check = process.argv.includes("--check");
let stale = false;
for (const { file, schema } of schemas) {
  const target = path.join(root, "schema", file);
  const next = `${JSON.stringify(schema, null, 2)}\n`;
  if (check) {
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (current !== next) {
      console.error(`${target} is stale. Run: npm run schema`);
      stale = true;
    }
  } else {
    writeFileSync(target, next);
    console.log(`wrote ${target}`);
  }
}
if (check) {
  if (stale) process.exit(1);
  console.log("schemas up to date");
}
