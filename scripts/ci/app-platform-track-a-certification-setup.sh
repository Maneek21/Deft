#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${CERTIFICATION_STAGE:?CERTIFICATION_STAGE is required}" == "setup" ]]
[[ "${CANDIDATE_SHA:?CANDIDATE_SHA is required}" == "d390f2c004979ab3b36bb24832d74d1e59538324" ]]
candidate_root="${CANDIDATE_ROOT:?CANDIDATE_ROOT is required}"
certifier_root="${CERTIFIER_ROOT:?CERTIFIER_ROOT is required}"
candidate_tag="${CANDIDATE_TAG:?CANDIDATE_TAG is required}"
network="${CERT_NETWORK:?CERT_NETWORK is required}"
source_database_url="${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
safe_dir="${SAFE_EVIDENCE_DIR:?SAFE_EVIDENCE_DIR is required}"
recovery_dir="${RECOVERY_DIR:?RECOVERY_DIR is required}"
app_docker_args_file="${APP_DOCKER_ARGS_FILE:?APP_DOCKER_ARGS_FILE is required}"
keyring_json="${DEFT_APP_RUN_KEYRINGS:?DEFT_APP_RUN_KEYRINGS is required}"
proof_email="${DEFT_TEST_EMAIL:?DEFT_TEST_EMAIL is required}"

phase6_setup="${certifier_root}/scripts/ci/app-platform-phase6-certification-setup.sh"
[[ -f "$phase6_setup" ]]
bash "$phase6_setup"

provider_runtime="${recovery_dir}/provider-runtime"
[[ -f "${provider_runtime}/server.mjs" ]]
track_a_source="${recovery_dir}/scheduled-connected-resource-campaigns-app"
cp -R "${candidate_root}/examples/scheduled-connected-resource-campaigns-app" "$track_a_source"
(
  cd "$track_a_source"
  node "${candidate_root}/packages/app-kit/dist/cli.js" app check
  node "${candidate_root}/packages/app-kit/dist/cli.js" app build
)
track_a_package="${track_a_source}/.deft/app.deftapp.json"
[[ -f "$track_a_package" ]]
sha256sum "$track_a_package" | cut -d ' ' -f 1 > "$safe_dir/track-a-package.sha256"

{
  printf '%s\n' '-e'
  printf '%s\n' 'DEFT_APP_AUTOMATIONS_ENABLED=true'
} >> "$app_docker_args_file"

docker run --rm --network "$network" \
  -v "${provider_runtime}:/deft-provider:ro" \
  -v "${track_a_package}:/proof/track-a.deftapp.json:ro" \
  -v "${certifier_root}/apps/api/src/scripts/app-platform-track-a-certification-setup.ts:/app/apps/api/src/scripts/app-platform-track-a-certification-setup.ts:ro" \
  -v "${safe_dir}:/evidence" \
  -e DATABASE_URL="$source_database_url" \
  -e DEFT_TEST_DATABASE_URL="$source_database_url" \
  -e JWT_SECRET=phase6-cert-jwt-not-for-prod \
  -e JWT_REFRESH_SECRET=phase6-cert-refresh-not-for-prod \
  -e ENCRYPTION_KEY=phase6-cert-envelope-key-32bytes \
  -e DEFT_APPS_ENABLED=true \
  -e DEFT_APP_RUNS_ENABLED=true \
  -e DEFT_APP_RUN_APP_ORIGIN_ENABLED=true \
  -e DEFT_APP_AUTOMATIONS_ENABLED=true \
  -e DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=false \
  -e DEFT_APP_RUN_KEYRINGS="$keyring_json" \
  -e DEFT_SELF_HOSTED=true \
  -e DEFT_MCP_ENABLE_UNSAFE_STDIO=true \
  -e MCP_STDIO_ALLOWED_COMMANDS=/usr/local/bin/node \
  -e DEFT_TEST_EMAIL="$proof_email" \
  -e DEFT_TRACK_A_PACKAGE_PATH=/proof/track-a.deftapp.json \
  -e DEFT_TRACK_A_SETUP_EVIDENCE=/evidence/track-a-setup-summary.json \
  --entrypoint sh "$candidate_tag" \
  -c 'pnpm --filter @deft/api exec tsx src/scripts/app-platform-track-a-certification-setup.ts'

node --input-type=module - "$safe_dir/track-a-setup-summary.json" <<'NODE'
import { readFileSync } from 'node:fs';
const value = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (
  value?.schema !== 'deft.app_platform.track_a.setup.v1'
  || value?.result !== 'passed'
  || value?.app?.protocol !== '2'
  || value?.app?.version !== '4.0.0'
  || value?.app?.state !== 'active'
  || value?.dependency?.version !== '1.0.0'
  || value?.dependency?.state !== 'active'
  || value?.connector !== 'reviewed_stdio_sandbox'
  || value?.campaign_records !== 1
  || value?.contact_records !== 1
  || value?.related_contacts !== 1
  || value?.automation_definitions !== 0
) throw new Error('Track A setup evidence is invalid');
NODE

cp "$certifier_root/scripts/ci/app-platform-track-a-browser-fixture.example.json" \
  "$safe_dir/track-a-browser-fixture.json"
chmod 0644 "$safe_dir/track-a-browser-fixture.json"
