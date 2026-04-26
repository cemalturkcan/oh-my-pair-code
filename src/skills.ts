import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

export function discoverInstalledSkills(
  skillDirs = getDefaultSkillDirs(),
): string[] {
  const names = new Set<string>();

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
          names.add(entry);
        }
      } catch {
        continue;
      }
    }
  }

  return normalizeSkillNames([...names]);
}

export function resolveInstalledSkills(skillNames?: readonly string[]): string[] {
  return skillNames === undefined
    ? discoverInstalledSkills()
    : normalizeSkillNames(skillNames);
}

export function isSkillInstalled(
  skillName: string,
  skillNames?: readonly string[],
): boolean {
  return resolveInstalledSkills(skillNames).includes(skillName);
}
