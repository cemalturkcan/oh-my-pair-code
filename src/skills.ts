import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type InstalledSkillInfo = {
  name: string;
  description?: string;
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function getDefaultSkillDirs(): string[] {
  const dirs: string[] = [];
  const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();

  if (opencodeConfigDir) {
    dirs.push(join(resolve(opencodeConfigDir), "skills"));
  }

  if (xdgConfigHome) {
    dirs.push(join(resolve(xdgConfigHome), "opencode", "skills"));
  }

  dirs.push(
    join(homedir(), ".config", "opencode", "skills"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".claude", "skills"),
  );

  return unique(dirs);
}

export function normalizeSkillNames(skillNames: readonly string[]): string[] {
  return unique(skillNames.map((name) => name.trim()).filter(Boolean)).sort();
}

function cleanFrontmatterValue(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "").trim();
}

function parseFrontmatterDescription(frontmatter: string): string | undefined {
  const lines = frontmatter.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^description:\s*(.*)$/);
    if (!match) continue;

    const value = match[1]?.trim() ?? "";
    if (!value.startsWith(">") && !value.startsWith("|")) {
      return value ? cleanFrontmatterValue(value) : undefined;
    }

    const collected: string[] = [];
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const line = lines[nextIndex] ?? "";
      if (/^[A-Za-z0-9_-]+:\s*/.test(line)) break;
      if (line.trim().length > 0) {
        collected.push(line.trim());
      }
    }

    const joined = value.startsWith("|")
      ? collected.join("\n")
      : collected.join(" ");
    return cleanFrontmatterValue(joined.replace(/\s+/g, " "));
  }

  return undefined;
}

function parseSkillDescription(raw: string): string | undefined {
  const frontmatter = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  const frontmatterDescription = frontmatter?.[1]
    ? parseFrontmatterDescription(frontmatter[1])
    : undefined;
  if (frontmatterDescription) {
    return frontmatterDescription;
  }

  const purpose = raw.match(/## Purpose\s+([\s\S]*?)(?:\n##\s|\n#\s|$)/i)?.[1];
  const firstPurposeLine = purpose
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("-"));

  return firstPurposeLine ? cleanFrontmatterValue(firstPurposeLine) : undefined;
}

function readSkillInfo(skillPath: string, fallbackName: string): InstalledSkillInfo {
  try {
    const raw = readFileSync(join(skillPath, "SKILL.md"), "utf8");
    return {
      name: fallbackName,
      description: parseSkillDescription(raw),
    };
  } catch {
    return { name: fallbackName };
  }
}

export function discoverInstalledSkillDetails(
  skillDirs = getDefaultSkillDirs(),
): InstalledSkillInfo[] {
  const skills = new Map<string, InstalledSkillInfo>();

  for (const dir of skillDirs) {
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillPath = join(dir, entry);
      try {
        if (
          statSync(skillPath).isDirectory() &&
          existsSync(join(skillPath, "SKILL.md"))
        ) {
          const info = readSkillInfo(skillPath, entry);
          if (!skills.has(info.name)) {
            skills.set(info.name, info);
          }
        }
      } catch {
        continue;
      }
    }
  }

  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverInstalledSkills(
  skillDirs = getDefaultSkillDirs(),
): string[] {
  return discoverInstalledSkillDetails(skillDirs).map((skill) => skill.name);
}

export function resolveInstalledSkills(skillNames?: readonly string[]): string[] {
  return skillNames === undefined
    ? discoverInstalledSkills()
    : normalizeSkillNames(skillNames);
}

export function resolveInstalledSkillDetails(
  skillNames?: readonly string[],
): InstalledSkillInfo[] {
  if (skillNames === undefined) {
    return discoverInstalledSkillDetails();
  }

  const discovered = new Map(
    discoverInstalledSkillDetails().map((skill) => [skill.name, skill]),
  );

  return normalizeSkillNames(skillNames).map(
    (name) => discovered.get(name) ?? { name },
  );
}

export function isSkillInstalled(
  skillName: string,
  skillNames?: readonly string[],
): boolean {
  return resolveInstalledSkills(skillNames).includes(skillName);
}
