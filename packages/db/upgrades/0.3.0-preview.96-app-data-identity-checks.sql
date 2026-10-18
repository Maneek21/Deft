-- Preserve the exact opaque locator limits without PostgreSQL bounded-repeat
-- syntax exceeding its255 maximum. Applied95 remains byte-identical.
ALTER TABLE app_data_consents DROP CONSTRAINT app_data_consents_identity_check;
ALTER TABLE app_data_consents ADD CONSTRAINT app_data_consents_identity_check CHECK((
   jsonb_typeof(snapshot)='object' AND snapshot->>'schema_version'='deft.app_data_consent.v1'
   AND snapshot->>'consent_id'=consent_id AND snapshot->'scope'->>'org_id'=org_id
   AND snapshot->'scope'->>'owner_user_id'=owner_user_id AND snapshot->'connection'->>'session_id'=connection_session_id
   AND snapshot->'store'->>'key'=store_key AND snapshot->>'purpose'='human_record_write'
   AND consent_digest ~ '^sha256:[a-f0-9]{64}$'
   AND jsonb_typeof(snapshot->'scope')='object' AND jsonb_typeof(snapshot->'connection')='object' AND jsonb_typeof(snapshot->'store')='object'
   AND (snapshot-'schema_version'-'consent_id'-'scope'-'connection'-'store'-'data_policy_digest'-'purpose'-'expires_at')='{}'::jsonb
   AND snapshot ?& ARRAY['schema_version','consent_id','scope','connection','store','data_policy_digest','purpose','expires_at']
   AND snapshot->>'data_policy_digest' ~ '^sha256:[a-f0-9]{64}$'
   AND snapshot->'connection' ?& ARRAY['session_id','session_revision','runtime_session_ref','account_ref']
   AND (snapshot->'connection')-ARRAY['session_id','session_revision','runtime_session_ref','account_ref']='{}'::jsonb
   AND snapshot->'connection'->>'runtime_session_ref' ~ '^[A-Za-z0-9_-]+$' AND char_length(snapshot->'connection'->>'runtime_session_ref') BETWEEN 1 AND 512
   AND snapshot->'connection'->>'account_ref' ~ '^[A-Za-z0-9_-]+$' AND char_length(snapshot->'connection'->>'account_ref') BETWEEN 1 AND 512
   AND (snapshot->'connection'->>'session_revision')::numeric BETWEEN 1 AND 2147483646
   AND isfinite(expires_at) AND isfinite(created_at) AND isfinite(updated_at)
   AND (snapshot->>'expires_at')::timestamptz=expires_at
   AND expires_at<=(snapshot->'scope'->>'consent_expires_at')::timestamptz
  ) IS TRUE);
ALTER TABLE app_data_invocations DROP CONSTRAINT app_data_invocations_identity_check;
ALTER TABLE app_data_invocations ADD CONSTRAINT app_data_invocations_identity_check CHECK((
   jsonb_typeof(context)='object' AND context->>'schema_version'='deft.app_data_authority.v1'
   AND context->>'request_id'=request_id AND context->>'operation'=operation AND context->>'input_digest'=input_digest
   AND context->'scope'->>'org_id'=org_id AND context->'scope'->>'owner_user_id'=owner_user_id
   AND context->'connection'->>'session_id'=connection_session_id AND input_digest ~ '^sha256:[a-f0-9]{64}$'
   AND jsonb_typeof(context->'scope')='object' AND jsonb_typeof(context->'connection')='object' AND jsonb_typeof(context->'authority')='object'
   AND (context-'schema_version'-'request_id'-'scope'-'connection'-'authority'-'operation'-'input_digest'-'expires_at')='{}'::jsonb
   AND context ?& ARRAY['schema_version','request_id','scope','connection','authority','operation','input_digest','expires_at']
   AND context->'connection' ?& ARRAY['session_id','session_revision','runtime_session_ref','account_ref']
   AND (context->'connection')-ARRAY['session_id','session_revision','runtime_session_ref','account_ref']='{}'::jsonb
   AND context->'authority' ?& ARRAY['consent_id','consent_digest','data_policy_digest']
   AND (context->'authority')-ARRAY['consent_id','consent_digest','data_policy_digest']='{}'::jsonb
   AND context->'authority'->>'data_policy_digest' ~ '^sha256:[a-f0-9]{64}$'
   AND ((context->'authority'->'consent_id'='null'::jsonb AND context->'authority'->'consent_digest'='null'::jsonb)
     OR (jsonb_typeof(context->'authority'->'consent_id')='string' AND context->'authority'->>'consent_digest' ~ '^sha256:[a-f0-9]{64}$'))
   AND context->'connection'->>'runtime_session_ref' ~ '^[A-Za-z0-9_-]+$' AND char_length(context->'connection'->>'runtime_session_ref') BETWEEN 1 AND 512
   AND context->'connection'->>'account_ref' ~ '^[A-Za-z0-9_-]+$' AND char_length(context->'connection'->>'account_ref') BETWEEN 1 AND 512
   AND (context->'connection'->>'session_revision')::numeric BETWEEN 1 AND 2147483646
   AND isfinite(expires_at) AND isfinite(access_expires_at) AND isfinite(created_at) AND isfinite(updated_at)
   AND (context->>'expires_at')::timestamptz=expires_at AND expires_at<=access_expires_at
   AND expires_at<=(context->'scope'->>'consent_expires_at')::timestamptz
  ) IS TRUE);
