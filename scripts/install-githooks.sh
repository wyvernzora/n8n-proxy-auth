#!/usr/bin/env bash
set -euo pipefail

git config core.hooksPath .githooks
echo "Configured Git to use .githooks for this checkout."
