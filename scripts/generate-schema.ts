// Writes schema/skillhook.schema.json from the zod config schema.
//   npm run schema            regenerate
//   npm run schema -- --check fail when the committed file is stale (CI)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ConfigSchema } from "../src/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = {
  $id: "https://raw.githubusercontent.com/MeterApp/skillhook/main/schema/skillhook.schema.json",
  title: "skillhook.json",
  description: "Server configuration for skillhook (https://github.com/MeterApp/skillhook).",
  ...z.toJSONSchema(ConfigSchema, { target: "draft-7", io: "input" }),
};
const file = path.join(root, "schema", "skillhook.schema.json");
const next = `${JSON.stringify(schema, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current !== next) {
    console.error(`${file} is stale. Run: npm run schema`);
    process.exit(1);
  }
  console.log("schema up to date");
} else {
  writeFileSync(file, next);
  console.log(`wrote ${file}`);
}
