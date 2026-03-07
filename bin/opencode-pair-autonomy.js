#!/usr/bin/env node

async function loadCli() {
  try {
    return await import("../dist/cli.js");
  } catch (error) {
    if (!process.versions.bun) {
      throw error;
    }

    return import("../src/cli.ts");
  }
}

loadCli()
  .then((mod) => mod.main(process.argv.slice(2)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
