#!/usr/bin/env bash
# List the story assets in the reader's GCS bucket into data_cache/asset_store_manifest.txt
# (one path per line, relative to the bucket root, sorted). build_scenarios.py checks voice
# clips, icons, motions, props and BGM against it, so the compiled JSON doesn't depend on what
# happens to be cached in public/assets/. Re-run after uploading assets.
#
# Env: HASU_ASSET_BUCKET  bucket to list (default gs://hasu-web-reader-assets)
set -euo pipefail

BUCKET="${HASU_ASSET_BUCKET:-gs://hasu-web-reader-assets}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/data_cache/asset_store_manifest.txt"

for prefix in story/voice assets/charaicon 3d/motions 3d/ppadv bgm; do
  gcloud storage ls "$BUCKET/$prefix/**"
done | sed "s|^$BUCKET/||" | grep -v '/$' | LC_ALL=C sort > "$OUT"
echo "$(wc -l < "$OUT" | tr -d ' ') paths -> $OUT"
