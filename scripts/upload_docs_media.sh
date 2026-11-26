#!/usr/bin/env bash
# Upload the docs' generated images/videos to the public docs bucket. They're renders of game
# models, so they live in a bucket rather than git (the asset bucket itself is private):
#   docs/media/motion-proof.mp4  ->  gs://hasu-web-reader-docs/docs/media/motion-proof.mp4
# Docs link them as https://storage.googleapis.com/hasu-web-reader-docs/docs/media/<file>.
# docs/media/ is only where render_motion_preview.py / crash_course_figures.py write their output;
# delete it after uploading.
#
# Usage:  scripts/upload_docs_media.sh                      # everything under docs/media/
#         scripts/upload_docs_media.sh motion-proof.mp4 crash-course/skeleton.png
set -euo pipefail

BUCKET="${HASU_DOCS_BUCKET:-gs://hasu-web-reader-docs}"
CACHE_CONTROL="${HASU_ASSET_CACHE_CONTROL:-public, max-age=3600}"
SRC="$(cd "$(dirname "$0")/.." && pwd)/docs/media"
PUBLIC="https://storage.googleapis.com/${BUCKET#gs://}/docs/media"

cd "$SRC"
if [ $# -eq 0 ]; then
  files=()
  while IFS= read -r f; do files+=("${f#./}"); done < <(find . -type f ! -name '.DS_Store' | sort)
  set -- "${files[@]}"
fi

for rel in "$@"; do
  [ -f "$rel" ] || { echo "not found: $SRC/$rel" >&2; exit 1; }
  gcloud storage cp "$rel" "$BUCKET/docs/media/$rel" --cache-control="$CACHE_CONTROL" --quiet
  echo "$PUBLIC/$rel"
done
