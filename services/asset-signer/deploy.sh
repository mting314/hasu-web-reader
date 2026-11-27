#!/usr/bin/env bash
# Deploy the GCS V4 signed-URL redirect service to Cloud Run (project future-name-201021).
set -euo pipefail

PROJECT="${GCP_PROJECT:-future-name-201021}"
REGION="${GCP_REGION:-us-central1}"
SERVICE="${CLOUD_RUN_SERVICE:-hasu-asset-signer}"
BUCKET="${HASU_ASSET_BUCKET:-hasu-web-reader-assets}"
SA_NAME="hasu-asset-signer"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
DIR="$(cd "$(dirname "$0")" && pwd)"

if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT" \
    --display-name="Hasu Web Reader GCS V4 URL Signer"
fi

# Least-privilege: read-only object access on the asset bucket + self signBlob permission.
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --project="$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectViewer" >/dev/null

gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountTokenCreator" >/dev/null

gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --source="$DIR" \
  --service-account="$SA_EMAIL" \
  --allow-unauthenticated \
  --cpu=1 \
  --memory=256Mi \
  --concurrency=250 \
  --max-instances=5 \
  --env-vars-file="${DIR}/env.yaml"
