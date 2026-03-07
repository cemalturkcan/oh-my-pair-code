#!/usr/bin/env node

import("../dist/cli.js").then((mod) => mod.main(process.argv.slice(2)));
