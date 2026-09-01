#!/usr/bin/env bash
set -Eeuo pipefail

phase5_sha="${PHASE5_CANDIDATE_SHA:?PHASE5_CANDIDATE_SHA is required}"
phase4_sha="${PHASE4_BASELINE_SHA:?PHASE4_BASELINE_SHA is required}"
predecessor_image="${PREDECESSOR_IMAGE:?PREDECESSOR_IMAGE is required}"
predecessor_commit="${PREDECESSOR_COMMIT:?PREDECESSOR_COMMIT is required}"
certifier_root="${CERTIFIER_ROOT:?CERTIFIER_ROOT is required}"
phase5_root="${PHASE5_ROOT:?PHASE5_ROOT is required}"
phase4_root="${PHASE4_ROOT:?PHASE4_ROOT is required}"
evidence_root="${EVIDENCE_DIR:?EVIDENCE_DIR is required}"

run_id="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
run_attempt="${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
prefix="deft-p5-cert-${run_id}-${run_attempt}"
network="${prefix}-network"
source_container="${prefix}-source"
restore_container="${prefix}-restore"
app_container="${prefix}-app"
source_volume="${prefix}-source-data"
restore_volume="${prefix}-restore-data"
candidate_tag="deft:phase5-cert-${run_id}-${run_attempt}"
database_name="deft_phase4_phase5_release_test"
postgres_password="phase5-cert-postgres"
host_port=55432
source_url_host="postgres://postgres:${postgres_password}@127.0.0.1:${host_port}/${database_name}"
source_url_container="postgres://postgres:${postgres_password}@${source_container}:5432/${database_name}"
restore_url_container="postgres://postgres:${postgres_password}@${restore_container}:5432/${database_name}"
safe_dir="${evidence_root}/safe"
recovery_dir="${RUNNER_TEMP:?RUNNER_TEMP is required}/deft-phase5-recovery-${run_id}-${run_attempt}"
keyring_path="${recovery_dir}/app-run-keyrings.json"
restored_keyring_path="${recovery_dir}/restored-app-run-keyrings.json"
dump_path="${recovery_dir}/database.dump"
candidate_archive="${evidence_root}/candidate-image.tar.zst"
host_uid="$(id -u)"
host_gid="$(id -g)"

mkdir -p "$safe_dir" "$recovery_dir"
chmod 700 "$recovery_dir"

cleanup() {
  set +e
  docker rm -f "$app_container" "$restore_container" "$source_container" >/dev/null 2>&1
  docker network rm "$network" >/dev/null 2>&1
  docker volume rm "$restore_volume" "$source_volume" >/dev/null 2>&1
  rm -f "$keyring_path" "$restored_keyring_path" "$dump_path"
  rmdir "$recovery_dir" >/dev/null 2>&1
}
trap cleanup EXIT

wait_for_postgres() {
  local container="$1"
  for attempt in $(seq 1 30); do
    if docker exec "$container" pg_isready -U postgres -d "$database_name" >/dev/null 2>&1; then return 0; fi
    if [[ "$attempt" == 30 ]]; then
      docker logs "$container"
      return 1
    fi
    sleep 2
  done
}

run_candidate() {
  docker run --rm --network "$network" \
    -e DATABASE_URL="$1" \
    -e DEFT_TEST_DATABASE_URL="$1" \
    -e JWT_SECRET=phase5-cert-jwt-not-for-prod \
    -e JWT_REFRESH_SECRET=phase5-cert-refresh-not-for-prod \
    -e ENCRYPTION_KEY=phase5-cert-envelope-key-32bytes \
    --entrypoint sh "$candidate_tag" -c "$2"
}

[[ "$(git -C "$phase5_root" rev-parse HEAD)" == "$phase5_sha" ]]
[[ "$(git -C "$phase4_root" rev-parse HEAD)" == "$phase4_sha" ]]

docker network create "$network" >/dev/null
docker volume create "$source_volume" >/dev/null
docker volume create "$restore_volume" >/dev/null
docker run -d --name "$source_container" --network "$network" -p "${host_port}:5432" \
  -v "${source_volume}:/var/lib/postgresql/data" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$postgres_password" -e POSTGRES_DB="$database_name" \
  pgvector/pgvector:pg16 >/dev/null
wait_for_postgres "$source_container"
docker exec "$source_container" psql -U postgres -d "$database_name" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;'
docker exec "$source_container" psql -U postgres -d "$database_name" -Atc \
  "SELECT extversion FROM pg_extension WHERE extname = 'vector'" > "$safe_dir/pgvector-version.txt"

(
  cd "$phase4_root"
  pnpm --filter @deft/app-kit build
  DATABASE_URL="$source_url_host" pnpm db:push-full
  DATABASE_URL="$source_url_host" DEFT_TEST_DATABASE_URL="$source_url_host" \
    JWT_SECRET=phase5-cert-jwt-not-for-prod \
    JWT_REFRESH_SECRET=phase5-cert-refresh-not-for-prod \
    ENCRYPTION_KEY=phase5-cert-envelope-key-32bytes \
    pnpm --filter @deft/api exec tsx --test test/resource-participation-apps-db.test.ts
)

docker buildx build --load \
  --tag "$candidate_tag" \
  --iidfile "$safe_dir/candidate-buildkit-iid.txt" \
  --metadata-file "$safe_dir/candidate-buildkit-metadata.json" \
  --build-arg "VCS_REF=$phase5_sha" \
  --build-arg NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000 \
  --build-arg NEXT_PUBLIC_API_URL=http://127.0.0.1:3001 \
  --build-arg NEXT_PUBLIC_WS_URL=http://127.0.0.1:3001 \
  --build-arg NEXT_PUBLIC_FEATURE_HUDDLES=true \
  --build-arg NEXT_PUBLIC_FEATURE_APPS=true \
  "$phase5_root"

image_revision="$(docker image inspect "$candidate_tag" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$image_revision" == "$phase5_sha" ]]
docker image inspect "$candidate_tag" > "$safe_dir/candidate-image-inspect.json"
printf '%s\n' "$image_revision" > "$safe_dir/candidate-image-revision.txt"

run_candidate "$source_url_container" 'pnpm db:upgrade && pnpm module:verify'
run_candidate "$source_url_container" 'pnpm db:seed:demo'
docker run --rm --network "$network" \
  -v "${phase5_root}/examples:/app/examples:ro" \
  -e DATABASE_URL="$source_url_container" \
  -e DEFT_TEST_DATABASE_URL="$source_url_container" \
  -e JWT_SECRET=phase5-cert-jwt-not-for-prod \
  -e JWT_REFRESH_SECRET=phase5-cert-refresh-not-for-prod \
  -e ENCRYPTION_KEY=phase5-cert-envelope-key-32bytes \
  --entrypoint sh "$candidate_tag" \
  -c 'pnpm --filter @deft/api exec tsx --test test/phase5-proof-package-determinism.test.ts test/phase5-sandbox-email-provider.test.ts test/app-origin-run-lifecycle-db.test.ts'

docker run --rm --network "$network" \
  -e DATABASE_URL="$source_url_container" \
  -e DEFT_TEST_EMAIL=diego@testers-tomatoes.com \
  -e DEFT_APPROVAL_SMOKE_MARKER="Phase 5 certification ${run_id}" \
  --entrypoint sh "$candidate_tag" -c 'pnpm test:product-browser:seed'

proof_email="$(docker exec "$source_container" psql -U postgres -d "$database_name" -qAtc "
  WITH demo AS (
    SELECT password_hash FROM users WHERE email = 'diego@testers-tomatoes.com'
  )
  UPDATE users AS proof
     SET password_hash = demo.password_hash, email_verified = true
    FROM demo
   WHERE proof.email LIKE 'loop5-owner-%@example.test'
   RETURNING proof.email")"
[[ "$proof_email" == loop5-owner-*@example.test ]]

docker run --rm --network "$network" \
  -v "${certifier_root}/scripts/ci/app-platform-phase5-certification-probe.ts:/app/scripts/ci/app-platform-phase5-certification-probe.ts:ro" \
  -v "${recovery_dir}:/recovery" \
  -e DATABASE_URL="$source_url_container" -e DEFT_TEST_DATABASE_URL="$source_url_container" \
  -e HOST_UID="$host_uid" -e HOST_GID="$host_gid" \
  --entrypoint sh "$candidate_tag" \
  -c 'pnpm exec tsx scripts/ci/app-platform-phase5-certification-probe.ts keyring --output /recovery/app-run-keyrings.json && chown "$HOST_UID:$HOST_GID" /recovery/app-run-keyrings.json'
chmod 600 "$keyring_path"
keyring_hash="$(sha256sum "$keyring_path" | cut -d ' ' -f 1)"
printf '%s\n' "$keyring_hash" > "$safe_dir/app-run-keyring.sha256"

keyring_json="$(tr -d '\n' < "$keyring_path")"
docker run --rm --network "$network" \
  -v "${certifier_root}/scripts/ci/app-platform-phase5-certification-probe.ts:/app/scripts/ci/app-platform-phase5-certification-probe.ts:ro" \
  -v "${safe_dir}:/evidence" \
  -e DATABASE_URL="$source_url_container" -e DEFT_TEST_DATABASE_URL="$source_url_container" \
  -e DEFT_APP_RUN_KEYRINGS="$keyring_json" \
  -e HOST_UID="$host_uid" -e HOST_GID="$host_gid" \
  --entrypoint sh "$candidate_tag" \
  -c 'pnpm exec tsx scripts/ci/app-platform-phase5-certification-probe.ts snapshot --output /evidence/source-snapshot.json && chown "$HOST_UID:$HOST_GID" /evidence/source-snapshot.json'

docker exec "$source_container" pg_dump -U postgres -d "$database_name" -Fc > "$dump_path"
chmod 600 "$dump_path"
sha256sum "$dump_path" | cut -d ' ' -f 1 > "$safe_dir/database-dump.sha256"
cp "$keyring_path" "$restored_keyring_path"
chmod 600 "$restored_keyring_path"
[[ "$(sha256sum "$restored_keyring_path" | cut -d ' ' -f 1)" == "$keyring_hash" ]]
restored_keyring_json="$(tr -d '\n' < "$restored_keyring_path")"

docker run -d --name "$restore_container" --network "$network" \
  -v "${restore_volume}:/var/lib/postgresql/data" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$postgres_password" -e POSTGRES_DB="$database_name" \
  pgvector/pgvector:pg16 >/dev/null
wait_for_postgres "$restore_container"
docker exec "$restore_container" psql -U postgres -d "$database_name" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;'
docker exec -i "$restore_container" pg_restore -U postgres -d "$database_name" --clean --if-exists < "$dump_path"

read -r probe_org probe_employee probe_record < <(
  docker exec "$restore_container" psql -U postgres -d "$database_name" -At -F ' ' -c "
    SELECT mr.org_id, ae.id, mr.id
      FROM module_records mr
      JOIN module_installations mi ON mi.id = mr.installation_id AND mi.org_id = mr.org_id
      JOIN agent_employees ae ON ae.org_id = mr.org_id AND ae.is_active = true AND ae.is_deleted = false
     WHERE mr.data->>'name' = 'Ada Lovelace'
       AND mr.is_deleted = false
       AND mi.agent_access IN ('read', 'write')
     ORDER BY mr.created_at
     LIMIT 1"
)
[[ -n "$probe_org" && -n "$probe_employee" && -n "$probe_record" ]]

docker pull "$predecessor_image"
predecessor_revision="$(docker image inspect "$predecessor_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$predecessor_revision" == "$predecessor_commit" ]]
printf '%s\n' "$predecessor_image" > "$safe_dir/predecessor-image.txt"
printf '%s\n' "$predecessor_revision" > "$safe_dir/predecessor-image-revision.txt"
docker run --rm --network "$network" \
  -v "${certifier_root}/apps/api/test/phase5-predecessor-read-probe.ts:/app/apps/api/test/phase5-predecessor-read-probe.ts:ro" \
  -e DATABASE_URL="$restore_url_container" \
  -e DEFT_PROBE_ORG_ID="$probe_org" \
  -e DEFT_PROBE_EMPLOYEE_ID="$probe_employee" \
  -e DEFT_PROBE_RECORD_ID="$probe_record" \
  --entrypoint sh "$predecessor_image" \
  -c 'pnpm --filter @deft/api exec tsx test/phase5-predecessor-read-probe.ts' \
  > "$safe_dir/predecessor-read.json"

docker run --rm --network "$network" \
  -v "${certifier_root}/scripts/ci/app-platform-phase5-certification-probe.ts:/app/scripts/ci/app-platform-phase5-certification-probe.ts:ro" \
  -v "${safe_dir}:/evidence" \
  -e DATABASE_URL="$restore_url_container" -e DEFT_TEST_DATABASE_URL="$restore_url_container" \
  -e JWT_SECRET=phase5-cert-jwt-not-for-prod \
  -e JWT_REFRESH_SECRET=phase5-cert-refresh-not-for-prod \
  -e ENCRYPTION_KEY=phase5-cert-envelope-key-32bytes \
  -e DEFT_APPS_ENABLED=true \
  -e DEFT_APP_RUNS_ENABLED=true \
  -e DEFT_APP_RUN_APP_ORIGIN_ENABLED=true \
  -e DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=false \
  -e DEFT_APP_RUN_KEYRINGS="$restored_keyring_json" \
  -e HOST_UID="$host_uid" -e HOST_GID="$host_gid" \
  --entrypoint sh "$candidate_tag" \
  -c 'pnpm exec tsx scripts/ci/app-platform-phase5-certification-probe.ts verify --expected-snapshot /evidence/source-snapshot.json --output /evidence/restored-verification.json && chown "$HOST_UID:$HOST_GID" /evidence/restored-verification.json'

docker run -d --name "$app_container" --network "$network" -p 3000:3000 -p 3001:3001 \
  -e DATABASE_URL="$restore_url_container" \
  -e JWT_SECRET=phase5-cert-jwt-not-for-prod \
  -e JWT_REFRESH_SECRET=phase5-cert-refresh-not-for-prod \
  -e ENCRYPTION_KEY=phase5-cert-envelope-key-32bytes \
  -e DEFT_APPS_ENABLED=true \
  -e DEFT_APP_RUNS_ENABLED=true \
  -e DEFT_APP_RUN_APP_ORIGIN_ENABLED=true \
  -e DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=false \
  -e DEFT_APP_RUN_KEYRINGS="$restored_keyring_json" \
  -e NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000 \
  -e NEXT_PUBLIC_API_URL=http://127.0.0.1:3001 \
  -e NEXT_PUBLIC_WS_URL=http://127.0.0.1:3001 \
  -e NEXT_PUBLIC_FEATURE_APPS=true \
  "$candidate_tag" >/dev/null
for attempt in $(seq 1 45); do
  if curl --fail --silent http://127.0.0.1:3001/health >/dev/null \
    && curl --fail --silent http://127.0.0.1:3000/login >/dev/null; then break; fi
  if [[ "$attempt" == 45 ]]; then docker logs "$app_container"; exit 1; fi
  sleep 2
done

DEFT_WEB_URL=http://127.0.0.1:3000 \
DEFT_TEST_EMAIL="$proof_email" \
DEFT_TEST_PASSWORD=tomato123 \
DEFT_APP_PLATFORM_REQUIRE_CONNECTED=true \
DEFT_APP_RUN_KEYRINGS="$restored_keyring_json" \
JWT_SECRET=phase5-cert-jwt-not-for-prod \
JWT_REFRESH_SECRET=phase5-cert-refresh-not-for-prod \
ENCRYPTION_KEY=phase5-cert-envelope-key-32bytes \
DEFT_APP_PLATFORM_EVIDENCE_DIR="$safe_dir" \
DEFT_APP_PLATFORM_BROWSER_EVIDENCE="$safe_dir/browser-evidence.json" \
node "$certifier_root/scripts/ci/app-platform-phase5-browser-smoke.mjs"

docker save "$candidate_tag" | zstd -T0 -10 -o "$candidate_archive"
sha256sum "$candidate_archive" | cut -d ' ' -f 1 > "$safe_dir/candidate-image-archive.sha256"
docker exec "$restore_container" psql -U postgres -d "$database_name" -Atc \
  "SELECT version || '|' || kind FROM deft_schema_migrations ORDER BY applied_at, version" \
  > "$safe_dir/migration-ledger.txt"

CERTIFIER_SHA="${CERTIFIER_SHA:?CERTIFIER_SHA is required}" \
PHASE5_CANDIDATE_SHA="$phase5_sha" PHASE4_BASELINE_SHA="$phase4_sha" \
PREDECESSOR_IMAGE="$predecessor_image" IMAGE_REVISION="$image_revision" \
node --input-type=module - "$safe_dir/certification-summary.json" <<'NODE'
import { writeFileSync } from 'node:fs';
const output = process.argv[2];
writeFileSync(output, `${JSON.stringify({
  schema: 'deft.app_platform.phase5.release_host.v1',
  result: 'passed',
  certifier_sha: process.env.CERTIFIER_SHA,
  candidate_sha: process.env.PHASE5_CANDIDATE_SHA,
  baseline_sha: process.env.PHASE4_BASELINE_SHA,
  candidate_revision: process.env.IMAGE_REVISION,
  predecessor_image: process.env.PREDECESSOR_IMAGE,
  published: false,
}, null, 2)}\n`, { mode: 0o644 });
NODE

echo 'Phase 5 immutable non-publishing certification passed.'
