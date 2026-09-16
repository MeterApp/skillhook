import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillDocument, type Skill } from "./skills.js";

/** Bundled example skills live in `examples/skills/<name>/` at the package root. */
export function examplesDir(): string {
  const here = fileURLToPath(import.meta.url); // dist/examples.js or src/examples.ts
  return path.resolve(path.dirname(here), "..", "examples", "skills");
}

export interface ExampleSkill {
  name: string;
  dir: string;
  description: string;
  skill?: Skill;
  error?: string;
}

export function listExamples(dir = examplesDir()): ExampleSkill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const skillDir = path.join(dir, e.name);
      try {
        const skill = parseSkillDocument(readFileSync(path.join(skillDir, "SKILL.md"), "utf8"), skillDir);
        return { name: e.name, dir: skillDir, description: skill.description, skill };
      } catch (error) {
        return { name: e.name, dir: skillDir, description: "", error: (error as Error).message };
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function findExample(name: string, dir = examplesDir()): ExampleSkill | undefined {
  return listExamples(dir).find((e) => e.name === name);
}
