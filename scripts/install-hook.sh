#!/bin/sh
set -eu

target="${1:-/out/hook.cjs}"
mkdir -p "$(dirname "$target")"
cp /hook.cjs "$target"
chmod 0444 "$target"
