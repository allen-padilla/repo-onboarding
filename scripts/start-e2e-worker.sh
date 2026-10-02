#!/usr/bin/env bash
# Starts the analysis worker for E2E runs. Playwright sets its environment:
# GitHub requests go to the GitHub stub, and no model keys are set. See
# playwright.config.ts and docs/architecture/testing.md.
set -euo pipefail

cd "$(dirname "$0")/../apps/worker"
exec ./node_modules/.bin/tsx src/main.ts
