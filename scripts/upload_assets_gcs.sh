#!/usr/bin/env bash
# Upload cached assets from public/assets/ to the reader's GCS bucket, mirroring paths:
#   public/assets/3d/costume/x/x.glb  ->  gs://hasu-web-reader-assets/3d/costume/x/x.glb
#
# Usage:  scripts/upload_assets_gcs.sh <path-under-public/assets> [...]
#   e.g.  scripts/upload_assets_gcs.sh 3d            # every 3D asset currently cached
#         scripts/upload_assets_gcs.sh 3d/costume    # just the costume models
#
# Env:
#   HASU_ASSET_BUCKET         destination bucket (default gs://hasu-web-reader-assets)
#   HASU_ASSET_CACHE_CONTROL  Cache-Control header (default "public, max-age=3600").
#                             Only use a long/immutable value once paths are versioned,
#                             otherwise browsers keep stale re-exports.
#
# GLB/JSON are stored gzip-encoded (GLBs shrink to ~60%); browsers decompress transparently.
# The bucket is public-read for objects (no listing) with CORS for GET/HEAD from any origin.
set -euo pipefail

BUCKET="${HASU_ASSET_BUCKET:-gs://hasu-web-reader-assets}"
CACHE_CONTROL="${HASU_ASSET_CACHE_CONTROL:-public, max-age=3600}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)/public/assets"

if [ $# -eq 0 ]; then
  echo "usage: $0 <path-under-public/assets> [...]" >&2
  exit 1
fi

for rel in "$@"; do
  rel="${rel%/}"
  src="$ROOT/$rel"
  if [ ! -e "$src" ]; then
    echo "not found: $src" >&2
    exit 1
  fi
  parent="$(dirname "$rel")"
  dest="$BUCKET"
  [ "$parent" != "." ] && dest="$BUCKET/$parent"
  echo "==> $rel  ->  $BUCKET/$rel"
  gcloud storage cp --recursive "$src" "$dest/" \
    --gzip-local=glb,json \
    --cache-control="$CACHE_CONTROL"
  # Python's mimetypes (used by gcloud) doesn't know .glb, and guesses video/webm for the
  # voice/SE clips, which are audio-only Opus.
  for ext_type in "glb:model/gltf-binary" "webm:audio/webm"; do
    ext="${ext_type%%:*}"
    ctype="${ext_type#*:}"
    if [ -d "$src" ]; then
      if gcloud storage ls "$BUCKET/$rel/**.$ext" >/dev/null 2>&1; then
        gcloud storage objects update "$BUCKET/$rel/**.$ext" --content-type="$ctype" >/dev/null
      fi
    elif [ "${rel##*.}" = "$ext" ]; then
      gcloud storage objects update "$BUCKET/$rel" --content-type="$ctype" >/dev/null
    fi
  done
done
