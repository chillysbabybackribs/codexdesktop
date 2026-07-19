#!/usr/bin/env bash
# doc-render: markdown -> polished standalone HTML, cache-proof filename.
# Usage: render.sh <input.md> [output-dir]   (default output-dir: /tmp/doc-render)
# Prints the file:// URL of the rendered document on the last line.
set -euo pipefail

IN="${1:?usage: render.sh <input.md> [output-dir]}"
OUTDIR="${2:-/tmp/doc-render}"
STYLE="$(dirname "$(dirname "$(readlink -f "$0")")")/assets/doc-style.html"

mkdir -p "$OUTDIR"
BASE="$(basename "${IN%.md}")"
TITLE="$(rg -m1 '^# ' "$IN" | sed 's/^# //' || true)"
[ -n "$TITLE" ] || TITLE="$BASE"

TMP="$OUTDIR/.render-$$.html"
pandoc -s -f gfm -t html5 \
  --include-in-header="$STYLE" \
  --metadata title="$TITLE" \
  -o "$TMP" "$IN"

# Content-hashed filename: the app browser caches file:// hard, and a plain
# reload serves stale CSS/HTML. A new name per content change defeats that.
HASH="$(md5sum "$TMP" | cut -c1-8)"
OUT="$OUTDIR/$BASE-$HASH.html"
mv "$TMP" "$OUT"
echo "file://$OUT"
