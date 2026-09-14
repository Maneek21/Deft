#!/usr/bin/env bash
set -euo pipefail
umask 077
leave_stopped=false
case "${1:-}" in
  '') ;;
  --leave-stopped) leave_stopped=true; shift ;;
  --help) echo 'Usage: bash backup-release.sh [--leave-stopped]'; exit 0 ;;
  *) echo 'Usage: bash backup-release.sh [--leave-stopped]' >&2; exit 1 ;;
esac
test "$#" -eq 0 || { echo 'Unexpected arguments.' >&2; exit 1; }
for tool in docker gzip sha256sum find sort xargs; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Run this example in Linux or WSL with Docker integration." >&2; exit 1; }
done
dc() { docker compose -f docker-compose.yml -f compose.prod.yml -f compose.release.yml "$@"; }
mkdir -p "$PWD/backups"
RECOVERY="$(mktemp -d "$PWD/backups/deft-recovery-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
container_id="$(dc ps -q deft)"
test -n "$container_id" || { echo 'Start from the running deployment.'; exit 1; }
uploads_volume="$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/app/uploads"}}{{.Name}}{{end}}{{end}}')"
test -n "$uploads_volume" || { echo 'Use the backup procedure for your storage mount.'; exit 1; }
docker volume inspect "$uploads_volume" >/dev/null
legacy_uploads="$(docker exec "$container_id" sh -c 'if [ -d /app/apps/api/uploads ]; then printf present; fi')"
dc stop deft
dc exec -T postgres pg_dump -U postgres --clean --if-exists --no-owner --no-privileges deft \
  | gzip -9 > "$RECOVERY/database.sql.gz"
docker run --rm -v "$uploads_volume:/source:ro" -v "$RECOVERY:/backup" alpine:3.22 \
  tar -C /source -czf /backup/uploads.tar.gz .
if [ "$legacy_uploads" = present ]; then
  mkdir "$RECOVERY/legacy-container-uploads"
  docker cp "$container_id:/app/apps/api/uploads/." "$RECOVERY/legacy-container-uploads/"
fi
docker inspect "$container_id" --format '{{.Image}}' > "$RECOVERY/running-image-id.txt"
docker image inspect "$(cat "$RECOVERY/running-image-id.txt")" --format '{{json .RepoDigests}}' \
  > "$RECOVERY/running-image-repo-digests.json"
cp .env docker-compose.yml compose.prod.yml compose.release.yml "$RECOVERY/"
for file in release-manifest.json SHA256SUMS; do
  if [ -f "$file" ]; then cp "$file" "$RECOVERY/release-$file"; fi
done
(cd "$RECOVERY" && find . -type f ! -name SHA256SUMS -print0 \
  | sort -z | xargs -0 sha256sum > SHA256SUMS)
printf 'Recovery folder: %s\n' "$RECOVERY"
if "$leave_stopped"; then
  echo 'Backup complete. Deft remains stopped for the upgrade.'
else
  dc start deft
  echo 'Backup complete. Deft restarted.'
fi
