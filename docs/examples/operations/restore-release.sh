#!/usr/bin/env bash
set -euo pipefail
umask 077
for tool in docker gunzip sha256sum; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Run this example in Linux or WSL with Docker integration." >&2; exit 1; }
done
: "${RECOVERY:?Set RECOVERY to the absolute path of your recovery folder}"
: "${DEFT_RESTORE_IMAGE:?Set DEFT_RESTORE_IMAGE to the digest saved in running-image-repo-digests.json}"
[[ "$RECOVERY" = /* ]] || { echo 'RECOVERY must be an absolute path.'; exit 1; }
[[ "$DEFT_RESTORE_IMAGE" =~ ^ghcr\.io/maneek21/deft@sha256:[a-f0-9]{64}$ ]] || { echo 'Use the saved Deft image digest.'; exit 1; }
(cd "$RECOVERY" && sha256sum -c SHA256SUMS)
RESTORE_PROJECT="${RESTORE_PROJECT:-deft-docs-restore}"
RESTORE_DIR="${RESTORE_DIR:-deft-restore}"
[[ "$RESTORE_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo 'RESTORE_PROJECT must use lowercase letters, digits, hyphens, or underscores.'; exit 1; }
test ! -e "$RESTORE_DIR" || { echo 'RESTORE_DIR already exists. Choose a new directory.'; exit 1; }
export COMPOSE_PROJECT_NAME="$RESTORE_PROJECT"
containers="$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")"
volumes="$(docker volume ls -q --filter "name=^${COMPOSE_PROJECT_NAME}_(pgdata|uploads)$")"
test -z "$containers$volumes" || { echo 'This restore project already has containers or volumes. Set RESTORE_PROJECT to an unused name.'; exit 1; }
mkdir "$RESTORE_DIR"
cd "$RESTORE_DIR"
cp "$RECOVERY/.env" "$RECOVERY/docker-compose.yml" "$RECOVERY/compose.prod.yml" "$RECOVERY/compose.release.yml" .
export DEFT_IMAGE="$DEFT_RESTORE_IMAGE"
export DEFT_BIND_HOST=127.0.0.1
export DEFT_WEB_PORT=127.0.0.1:3400
export DEFT_API_PORT=127.0.0.1:3401
export DEFT_POSTGRES_PORT=55432
export NEXT_PUBLIC_APP_URL=http://localhost:3400
export NEXT_PUBLIC_API_URL=http://localhost:3401
export NEXT_PUBLIC_WS_URL=http://localhost:3401
# Keep the rehearsal settings when this shell exits. Compose uses the last value.
cat >> .env <<EOF

# Restore rehearsal overrides
COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME
DEFT_IMAGE=$DEFT_IMAGE
DEFT_BIND_HOST=$DEFT_BIND_HOST
DEFT_WEB_PORT=$DEFT_WEB_PORT
DEFT_API_PORT=$DEFT_API_PORT
DEFT_POSTGRES_PORT=$DEFT_POSTGRES_PORT
NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
EOF
dc() { docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml "$@"; }
dc config --quiet
dc pull
dc up -d postgres
for attempt in {1..30}; do
  if dc exec -T postgres pg_isready -U postgres -d deft; then break; fi
  sleep 2
done
dc exec -T postgres pg_isready -U postgres -d deft
gunzip -c "$RECOVERY/database.sql.gz" | dc exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres deft
docker run --rm -v "${COMPOSE_PROJECT_NAME}_uploads:/target" -v "$RECOVERY:/backup:ro" alpine:3.22 \
  tar -C /target -xzf /backup/uploads.tar.gz
if [ -d "$RECOVERY/legacy-container-uploads" ]; then
  docker run --rm -v "${COMPOSE_PROJECT_NAME}_uploads:/target" \
    -v "$RECOVERY/legacy-container-uploads:/legacy:ro" alpine:3.22 cp -a /legacy/. /target/
fi
dc up -d deft
dc run --rm doctor
dc run --rm smoke
