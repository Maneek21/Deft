-- Add monotonic, security-relevant authority versions for governed App Runs.
-- Ordinary counters, heartbeat state, tool caches, and last-used timestamps do
-- not bump these versions. Revocation followed by restoration still does.

ALTER TABLE org_members
  ADD COLUMN IF NOT EXISTS app_run_authorization_version integer NOT NULL DEFAULT 1;
ALTER TABLE agent_employees
  ADD COLUMN IF NOT EXISTS app_run_authorization_version integer NOT NULL DEFAULT 1;
ALTER TABLE mcp_connections
  ADD COLUMN IF NOT EXISTS app_run_authorization_version integer NOT NULL DEFAULT 1;
ALTER TABLE mcp_tool_overrides
  ADD COLUMN IF NOT EXISTS app_run_authorization_version integer NOT NULL DEFAULT 1;
ALTER TABLE mcp_tokens
  ADD COLUMN IF NOT EXISTS app_run_authorization_version integer NOT NULL DEFAULT 1;
ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS app_run_authorization_version integer NOT NULL DEFAULT 1;

DO $$
DECLARE
  table_name text;
  constraint_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'org_members', 'agent_employees', 'mcp_connections',
    'mcp_tool_overrides', 'mcp_tokens', 'oauth_access_tokens'
  ] LOOP
    constraint_name := table_name || '_app_run_authorization_version_check';
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = constraint_name) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (app_run_authorization_version BETWEEN 1 AND 2147483647)',
        table_name,
        constraint_name
      );
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION bump_org_member_app_run_authorization_version() RETURNS trigger AS $$
BEGIN
  IF (NEW.user_id, NEW.role, NEW.is_active)
    IS DISTINCT FROM (OLD.user_id, OLD.role, OLD.is_active)
  THEN
    NEW.app_run_authorization_version := OLD.app_run_authorization_version + 1;
  ELSE
    NEW.app_run_authorization_version := OLD.app_run_authorization_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bump_agent_employee_app_run_authorization_version() RETURNS trigger AS $$
BEGIN
  IF (NEW.user_id, NEW.mcp_connection_ids, NEW.disabled_tools, NEW.trust_level,
      NEW.max_daily_actions, NEW.unhealthy, NEW.is_active, NEW.is_deleted)
    IS DISTINCT FROM
     (OLD.user_id, OLD.mcp_connection_ids, OLD.disabled_tools, OLD.trust_level,
      OLD.max_daily_actions, OLD.unhealthy, OLD.is_active, OLD.is_deleted)
  THEN
    NEW.app_run_authorization_version := OLD.app_run_authorization_version + 1;
  ELSE
    NEW.app_run_authorization_version := OLD.app_run_authorization_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bump_mcp_connection_app_run_authorization_version() RETURNS trigger AS $$
BEGIN
  IF (NEW.slug, NEW.server_url, NEW.transport, NEW.stdio_command, NEW.stdio_args,
      NEW.auth_type, NEW.auth_config_encrypted, NEW.is_active,
      NEW.default_trust_tier, NEW.enabled_tools)
    IS DISTINCT FROM
     (OLD.slug, OLD.server_url, OLD.transport, OLD.stdio_command, OLD.stdio_args,
      OLD.auth_type, OLD.auth_config_encrypted, OLD.is_active,
      OLD.default_trust_tier, OLD.enabled_tools)
  THEN
    NEW.app_run_authorization_version := OLD.app_run_authorization_version + 1;
  ELSE
    NEW.app_run_authorization_version := OLD.app_run_authorization_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bump_mcp_tool_override_app_run_authorization_version() RETURNS trigger AS $$
BEGIN
  IF (NEW.mcp_connection_id, NEW.tool_name, NEW.trust_tier_override, NEW.is_disabled)
    IS DISTINCT FROM
     (OLD.mcp_connection_id, OLD.tool_name, OLD.trust_tier_override, OLD.is_disabled)
  THEN
    NEW.app_run_authorization_version := OLD.app_run_authorization_version + 1;
  ELSE
    NEW.app_run_authorization_version := OLD.app_run_authorization_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bump_mcp_token_app_run_authorization_version() RETURNS trigger AS $$
BEGIN
  IF (NEW.user_id, NEW.agent_employee_id, NEW.principal_kind, NEW.scopes, NEW.revoked_at)
    IS DISTINCT FROM
     (OLD.user_id, OLD.agent_employee_id, OLD.principal_kind, OLD.scopes, OLD.revoked_at)
  THEN
    NEW.app_run_authorization_version := OLD.app_run_authorization_version + 1;
  ELSE
    NEW.app_run_authorization_version := OLD.app_run_authorization_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bump_oauth_access_token_app_run_authorization_version() RETURNS trigger AS $$
BEGIN
  IF (NEW.grant_id, NEW.org_id, NEW.user_id, NEW.client_id, NEW.resource,
      NEW.scopes, NEW.expires_at, NEW.revoked_at)
    IS DISTINCT FROM
     (OLD.grant_id, OLD.org_id, OLD.user_id, OLD.client_id, OLD.resource,
      OLD.scopes, OLD.expires_at, OLD.revoked_at)
  THEN
    NEW.app_run_authorization_version := OLD.app_run_authorization_version + 1;
  ELSE
    NEW.app_run_authorization_version := OLD.app_run_authorization_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS org_members_app_run_authorization_version_trigger ON org_members;
CREATE TRIGGER org_members_app_run_authorization_version_trigger
  BEFORE UPDATE ON org_members FOR EACH ROW
  EXECUTE FUNCTION bump_org_member_app_run_authorization_version();

DROP TRIGGER IF EXISTS agent_employees_app_run_authorization_version_trigger ON agent_employees;
CREATE TRIGGER agent_employees_app_run_authorization_version_trigger
  BEFORE UPDATE ON agent_employees FOR EACH ROW
  EXECUTE FUNCTION bump_agent_employee_app_run_authorization_version();

DROP TRIGGER IF EXISTS mcp_connections_app_run_authorization_version_trigger ON mcp_connections;
CREATE TRIGGER mcp_connections_app_run_authorization_version_trigger
  BEFORE UPDATE ON mcp_connections FOR EACH ROW
  EXECUTE FUNCTION bump_mcp_connection_app_run_authorization_version();

DROP TRIGGER IF EXISTS mcp_tool_overrides_app_run_authorization_version_trigger ON mcp_tool_overrides;
CREATE TRIGGER mcp_tool_overrides_app_run_authorization_version_trigger
  BEFORE UPDATE ON mcp_tool_overrides FOR EACH ROW
  EXECUTE FUNCTION bump_mcp_tool_override_app_run_authorization_version();

DROP TRIGGER IF EXISTS mcp_tokens_app_run_authorization_version_trigger ON mcp_tokens;
CREATE TRIGGER mcp_tokens_app_run_authorization_version_trigger
  BEFORE UPDATE ON mcp_tokens FOR EACH ROW
  EXECUTE FUNCTION bump_mcp_token_app_run_authorization_version();

DROP TRIGGER IF EXISTS oauth_access_tokens_app_run_authorization_version_trigger ON oauth_access_tokens;
CREATE TRIGGER oauth_access_tokens_app_run_authorization_version_trigger
  BEFORE UPDATE ON oauth_access_tokens FOR EACH ROW
  EXECUTE FUNCTION bump_oauth_access_token_app_run_authorization_version();

