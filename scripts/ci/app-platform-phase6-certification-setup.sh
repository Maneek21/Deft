#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${CERTIFICATION_STAGE:?CERTIFICATION_STAGE is required}" == "setup" ]]
candidate_root="${CANDIDATE_ROOT:?CANDIDATE_ROOT is required}"
certifier_root="${CERTIFIER_ROOT:?CERTIFIER_ROOT is required}"
candidate_tag="${CANDIDATE_TAG:?CANDIDATE_TAG is required}"
network="${CERT_NETWORK:?CERT_NETWORK is required}"
source_container="${SOURCE_CONTAINER:?SOURCE_CONTAINER is required}"
source_database_url="${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
safe_dir="${SAFE_EVIDENCE_DIR:?SAFE_EVIDENCE_DIR is required}"
recovery_dir="${RECOVERY_DIR:?RECOVERY_DIR is required}"
app_docker_args_file="${APP_DOCKER_ARGS_FILE:?APP_DOCKER_ARGS_FILE is required}"
upgrade_package_path="${UPGRADE_PACKAGE_PATH:?UPGRADE_PACKAGE_PATH is required}"
keyring_json="${DEFT_APP_RUN_KEYRINGS:?DEFT_APP_RUN_KEYRINGS is required}"
run_id="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
run_attempt="${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"

compose_project="deft-p6-compose-${run_id}-${run_attempt}"
compose_env="${recovery_dir}/phase6-compose.env"
compose_files=(
  -f "${candidate_root}/docker-compose.yml"
  -f "${candidate_root}/compose.prod.yml"
  -f "${certifier_root}/scripts/ci/app-platform-phase6-compose.yml"
)

compose() {
  DEFT_CERT_CANDIDATE_IMAGE="$candidate_tag" DEFT_CERT_ENV_FILE="$compose_env" \
    docker compose --project-name "$compose_project" --env-file "$compose_env" \
    "${compose_files[@]}" "$@"
}

compose_down() {
  set +e
  compose down --volumes --remove-orphans >/dev/null 2>&1
}
trap compose_down EXIT

umask 077
{
  printf 'POSTGRES_PASSWORD=%s\n' 'phase6-compose-postgres'
  printf 'JWT_SECRET=%s\n' 'phase6-compose-jwt-not-for-prod'
  printf 'JWT_REFRESH_SECRET=%s\n' 'phase6-compose-refresh-not-for-prod'
  printf 'ENCRYPTION_KEY=%s\n' 'phase6-compose-envelope-key-32bytes'
  printf 'NEXT_PUBLIC_APP_URL=%s\n' 'http://127.0.0.1:3100'
  printf 'NEXT_PUBLIC_API_URL=%s\n' 'http://127.0.0.1:3101'
  printf 'NEXT_PUBLIC_WS_URL=%s\n' 'http://127.0.0.1:3101'
  printf 'NEXT_PUBLIC_FEATURE_APPS=%s\n' 'true'
  printf 'DEFT_WEB_PORT=%s\n' '3100'
  printf 'DEFT_API_PORT=%s\n' '3101'
  printf 'DEFT_APPS_ENABLED=%s\n' 'true'
  printf 'DEFT_APP_RUNS_ENABLED=%s\n' 'true'
  printf 'DEFT_APP_RUN_APP_ORIGIN_ENABLED=%s\n' 'true'
  printf 'DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=%s\n' 'false'
  printf 'DEFT_APP_RUN_KEYRINGS=%s\n' "$keyring_json"
} > "$compose_env"

compose up -d postgres
compose --profile tools run --rm init
compose up -d deft
compose --profile tools run --rm doctor
compose --profile tools run --rm smoke
compose images --format json > "$safe_dir/phase6-compose-images.json"
compose_down
trap - EXIT

provider_pack_dir="${recovery_dir}/provider-pack"
provider_runtime="${recovery_dir}/provider-runtime"
mkdir -p "$provider_pack_dir" "$provider_runtime"
(
  cd "${candidate_root}/examples/app-platform-sandbox-email-provider"
  pnpm pack --pack-destination "$provider_pack_dir"
)
provider_tarball="$(find "$provider_pack_dir" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
[[ -n "$provider_tarball" && -f "$provider_tarball" ]]
tar -xzf "$provider_tarball" -C "$provider_runtime" --strip-components=1
[[ -f "$provider_runtime/server.mjs" && -f "$provider_runtime/package.json" ]]
sha256sum "$provider_tarball" | cut -d ' ' -f 1 > "$safe_dir/phase6-provider-package.sha256"

upgrade_source="${recovery_dir}/connected-resource-campaigns-upgrade"
cp -R "${candidate_root}/examples/connected-resource-campaigns-app" "$upgrade_source"
node --input-type=module - "$upgrade_source/deft.app.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.argv[2];
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const [major, minor, patch] = manifest.version.split('.').map(Number);
if (![major, minor, patch].every(Number.isInteger)) throw new Error('Expected a semver App version');
manifest.version = `${major}.${minor}.${patch + 1}`;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
(
  cd "$upgrade_source"
  node "${candidate_root}/packages/app-kit/dist/cli.js" app check
  node "${candidate_root}/packages/app-kit/dist/cli.js" app build
)
cp "$upgrade_source/.deft/app.deftapp.json" "$upgrade_package_path"
sha256sum "$upgrade_package_path" | cut -d ' ' -f 1 > "$safe_dir/phase6-upgrade-package.sha256"
sha256sum "$upgrade_source/.deft/requested-authority.json" | cut -d ' ' -f 1 \
  > "$safe_dir/phase6-upgrade-requested-authority.sha256"

connector_count="$(docker exec "$source_container" psql -U postgres -d "${DATABASE_NAME:?DATABASE_NAME is required}" -qAtc \
  "SELECT count(*) FROM mcp_connections WHERE slug LIKE 'loop5-mail-%'")"
[[ "$connector_count" == "1" ]]
docker exec "$source_container" psql -U postgres -d "$DATABASE_NAME" -v ON_ERROR_STOP=1 -q \
  -c "UPDATE mcp_connections
         SET server_url = NULL,
             transport = 'stdio',
             stdio_command = '/usr/local/bin/node',
             stdio_args = '[\"/deft-provider/server.mjs\"]'::jsonb,
             tools_cache = NULL,
             tools_cached_at = NULL,
             is_active = true,
             app_run_authorization_version = app_run_authorization_version + 1,
             updated_at = now()
       WHERE slug LIKE 'loop5-mail-%'" >/dev/null

{
  printf '%s\n' '-v'
  printf '%s\n' "${provider_runtime}:/deft-provider:ro"
  printf '%s\n' '-e' 'DEFT_SELF_HOSTED=true'
  printf '%s\n' '-e' 'DEFT_MCP_ENABLE_UNSAFE_STDIO=true'
  printf '%s\n' '-e' 'MCP_STDIO_ALLOWED_COMMANDS=/usr/local/bin/node'
} > "$app_docker_args_file"

docker run --rm --network "$network" \
  -v "${candidate_root}/examples:/app/examples:ro" \
  -e DATABASE_URL="$source_database_url" \
  -e DEFT_TEST_DATABASE_URL="$source_database_url" \
  -e JWT_SECRET=phase6-cert-jwt-not-for-prod \
  -e JWT_REFRESH_SECRET=phase6-cert-refresh-not-for-prod \
  -e ENCRYPTION_KEY=phase6-cert-envelope-key-32bytes \
  -e DEFT_APPS_ENABLED=true \
  -e DEFT_APP_RUNS_ENABLED=true \
  -e DEFT_APP_RUN_APP_ORIGIN_ENABLED=true \
  -e DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=false \
  -e DEFT_APP_RUN_KEYRINGS="$keyring_json" \
  --entrypoint sh "$candidate_tag" -c '
    pnpm --filter @deft/shared exec tsx --test test/capabilities.test.ts test/app-runs.test.ts &&
    pnpm --filter @deft/app-kit exec tsx --test \
      test/app-kit.test.ts \
      test/cli.test.ts \
      test/developer-contract.test.ts \
      test/protocol-v1.test.ts &&
    pnpm --filter @deft/api exec tsx --test \
      test/capability-service.test.ts \
      test/capability-immediate-execution-db.test.ts \
      test/app-action-service-db.test.ts \
      test/app-origin-run-cutover-db.test.ts \
      test/app-origin-run-lifecycle-db.test.ts \
      test/apps-connected-grants-db.test.ts \
      test/app-run-engine-db.test.ts \
      test/app-run-receipt-inspection.test.ts \
      test/app-run-secrets.test.ts \
      test/app-operations.test.ts \
      test/queue-health.test.ts \
      test/app-action-architecture.test.ts \
      test/app-run-architecture.test.ts \
      test/capability-architecture.test.ts \
      test/mcp-connector-safety.test.ts
  '

cat > "$safe_dir/phase6-setup-summary.json" <<'JSON'
{
  "schema": "deft.app_platform.phase6.setup.v1",
  "result": "passed",
  "self_host_compose": "exact_candidate",
  "provider": "separately_packed_stdio_sandbox",
  "upgrade": "public_app_kit_exact_package",
  "connector_authority": "invalidated_for_fresh_review",
  "conformance": "focused_phase4_to_phase6_matrix"
}
JSON
