-- Make a database dump restorable when these tables hold rows.
--
-- pg_dump output (plain SQL and custom format alike) restores with an empty
-- search_path. The CHECK constraints below call these helper functions, and the
-- helpers call each other without naming their schema. With an empty
-- search_path the nested call is not found, so loading a stored row failed:
--
--   COPY failed for table "app_connection_sessions":
--   ERROR: function deft_app_consent_valid(jsonb, text) does not exist
--   CONTEXT: PL/pgSQL function public.deft_app_consent_deadline(jsonb,text)
--
-- Every function a CHECK constraint calls directly now carries its own lookup
-- path, the same one the native Email guards use (0.3.0-preview.112). A helper
-- called from inside one of them runs under that path too. No function body, no
-- constraint and no stored row changes; in normal operation the same functions
-- are found in the same schema as before.
--
-- A later change that drops and recreates one of these functions, or adds a
-- helper to a CHECK constraint, an index expression or a generated column,
-- must carry the SET search_path clause.
-- packages/db/scripts/restore-custom-format-db.test.ts fails otherwise.
--
-- Constraints served (table.constraint):
--   app_connection_sessions.app_connection_sessions_record_identity
--   app_connection_forms.app_connection_forms_identity
--   app_data_consents.app_data_consents_identity_check
--   app_data_invocations.app_data_invocations_identity_check
--   app_resource_observation_consents.app_resource_observation_identity
--   app_local_job_schedules.app_local_job_schedule_shape
--   app_native_bindings.app_native_bindings_historical_create_check
--   app_public_cancellation_selections.app_public_cancellation_selections_pin_check
ALTER FUNCTION public.deft_app_consent_valid(jsonb, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.deft_app_consent_deadline(jsonb, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.deft_app_consent_snapshot_valid(jsonb, timestamp with time zone, timestamp with time zone) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.deft_app_connection_actions_v2_valid(jsonb, jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.deft_app_connection_reattachment_valid(jsonb, jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.deft_app_connection_upgrade_valid(jsonb, jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.deft_app_connection_credential_repair_record_valid(jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.deft_app_connection_form_record_valid(jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.deft_app_local_job_snapshot_valid(jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.deft_resource_observation_scope_valid(jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.valid_app_native_historical_create_policy(jsonb) SET search_path = pg_catalog, public, pg_temp;
