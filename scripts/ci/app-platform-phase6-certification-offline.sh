#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${CERTIFICATION_STAGE:?CERTIFICATION_STAGE is required}" == "offline" ]]
app_container="${APP_CONTAINER:?APP_CONTAINER is required}"
candidate_tag="${CANDIDATE_TAG:?CANDIDATE_TAG is required}"
network="${CERT_NETWORK:?CERT_NETWORK is required}"
restore_container="${RESTORE_CONTAINER:?RESTORE_CONTAINER is required}"
restore_database_url="${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
database_name="${DATABASE_NAME:?DATABASE_NAME is required}"
safe_dir="${SAFE_EVIDENCE_DIR:?SAFE_EVIDENCE_DIR is required}"
certifier_root="${CERTIFIER_ROOT:?CERTIFIER_ROOT is required}"
keyring_json="${DEFT_APP_RUN_KEYRINGS:?DEFT_APP_RUN_KEYRINGS is required}"
proof_email="${DEFT_TEST_EMAIL:?DEFT_TEST_EMAIL is required}"

read -r proof_org before_total before_succeeded before_failed < <(
  docker exec -i "$restore_container" psql -U postgres -d "$database_name" -qAt -F ' ' \
    -v proof_email="$proof_email" <<'SQL'
SELECT om.org_id,
       count(ar.id),
       count(ar.id) FILTER (WHERE ar.state = 'succeeded'),
       count(ar.id) FILTER (WHERE ar.state = 'failed')
  FROM users u
  JOIN org_members om ON om.user_id = u.id AND om.is_active = true
  LEFT JOIN app_runs ar ON ar.org_id = om.org_id AND ar.origin_kind = 'app'
 WHERE u.email = :'proof_email'
 GROUP BY om.org_id
SQL
)
[[ "$proof_org" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
[[ "$before_total" =~ ^[0-9]+$ && "$before_succeeded" =~ ^[0-9]+$ && "$before_failed" =~ ^[0-9]+$ ]]

docker rm -f "$app_container" >/dev/null
docker run -d --name "$app_container" --network "$network" -p 3000:3000 -p 3001:3001 \
  -e DATABASE_URL="$restore_database_url" \
  -e JWT_SECRET=phase5-cert-jwt-not-for-prod \
  -e JWT_REFRESH_SECRET=phase5-cert-refresh-not-for-prod \
  -e ENCRYPTION_KEY=phase5-cert-envelope-key-32bytes \
  -e DEFT_APPS_ENABLED=true \
  -e DEFT_APP_RUNS_ENABLED=true \
  -e DEFT_APP_RUN_APP_ORIGIN_ENABLED=true \
  -e DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=false \
  -e DEFT_APP_RUN_KEYRINGS="$keyring_json" \
  -e DEFT_SELF_HOSTED=true \
  -e DEFT_MCP_ENABLE_UNSAFE_STDIO=true \
  -e MCP_STDIO_ALLOWED_COMMANDS=/usr/local/bin/node \
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
DEFT_APP_RUN_KEYRINGS="$keyring_json" \
JWT_SECRET=phase5-cert-jwt-not-for-prod \
JWT_REFRESH_SECRET=phase5-cert-refresh-not-for-prod \
ENCRYPTION_KEY=phase5-cert-envelope-key-32bytes \
DEFT_APP_PLATFORM_EVIDENCE_DIR="$safe_dir" \
DEFT_APP_PLATFORM_OFFLINE_EVIDENCE="$safe_dir/offline-evidence.json" \
node "$certifier_root/scripts/ci/app-platform-phase6-offline-smoke.mjs"

read -r after_total after_succeeded after_failed < <(
  docker exec "$restore_container" psql -U postgres -d "$database_name" -qAt -F ' ' -c "
    SELECT count(*),
           count(*) FILTER (WHERE state = 'succeeded'),
           count(*) FILTER (WHERE state = 'failed')
      FROM app_runs
     WHERE org_id = '$proof_org' AND origin_kind = 'app'"
)
[[ "$after_total" == "$before_total" ]]
[[ "$after_succeeded" == "$before_succeeded" ]]
[[ "$after_failed" == "$before_failed" ]]

cat > "$safe_dir/phase6-offline-summary.json" <<'JSON'
{
  "schema": "deft.app_platform.phase6.offline.v1",
  "result": "passed",
  "candidate_booted_without_provider_mount": true,
  "local_resource_opened": true,
  "connector_reported_unhealthy": true,
  "invocation_failed_without_creating_a_run": true
}
JSON
