#!/usr/bin/env bash
set -euo pipefail

bun install
bun run build
bun link

printf '\nLinked package: opencode-pair-autonomy\n'
printf 'Run this next to patch your real OpenCode config and install plugin dependencies:\n\n'
printf '  opencode-pair-autonomy install\n'
