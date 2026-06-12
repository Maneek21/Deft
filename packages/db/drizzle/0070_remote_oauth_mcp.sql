CREATE TABLE IF NOT EXISTS "oauth_clients" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "client_secret_hash" text,
  "client_name" text NOT NULL,
  "client_uri" text,
  "logo_uri" text,
  "redirect_uris" text[] NOT NULL,
  "grant_types" text[] DEFAULT ARRAY['authorization_code','refresh_token']::text[] NOT NULL,
  "response_types" text[] DEFAULT ARRAY['code']::text[] NOT NULL,
  "token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
);

CREATE TABLE IF NOT EXISTS "oauth_authorization_codes" (
  "id" text PRIMARY KEY NOT NULL,
  "code_hash" text NOT NULL,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "client_id" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "code_challenge_method" text NOT NULL,
  "resource" text NOT NULL,
  "scopes" text[] NOT NULL,
  "expires_at" timestamp NOT NULL,
  "used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_authorization_codes_code_hash_unique" UNIQUE("code_hash")
);

CREATE TABLE IF NOT EXISTS "oauth_grants" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "client_id" text NOT NULL,
  "app_name" text NOT NULL,
  "connector_profile" text DEFAULT 'knowledge' NOT NULL,
  "scopes" text[] NOT NULL,
  "revoked_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "oauth_access_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "grant_id" text NOT NULL REFERENCES "oauth_grants"("id") ON DELETE cascade,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "client_id" text NOT NULL,
  "resource" text NOT NULL,
  "scopes" text[] NOT NULL,
  "expires_at" timestamp NOT NULL,
  "last_used_at" timestamp,
  "revoked_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_access_tokens_token_hash_unique" UNIQUE("token_hash")
);

CREATE TABLE IF NOT EXISTS "oauth_refresh_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "grant_id" text NOT NULL REFERENCES "oauth_grants"("id") ON DELETE cascade,
  "rotated_from" text,
  "expires_at" timestamp NOT NULL,
  "revoked_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);

CREATE TABLE IF NOT EXISTS "oauth_audit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text,
  "user_id" text REFERENCES "users"("id") ON DELETE set null,
  "client_id" text,
  "event" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "oauth_clients_client_id_idx" ON "oauth_clients" ("client_id");
CREATE INDEX IF NOT EXISTS "oauth_codes_hash_idx" ON "oauth_authorization_codes" ("code_hash");
CREATE INDEX IF NOT EXISTS "oauth_codes_client_idx" ON "oauth_authorization_codes" ("client_id");
CREATE INDEX IF NOT EXISTS "oauth_codes_user_idx" ON "oauth_authorization_codes" ("user_id");
CREATE INDEX IF NOT EXISTS "oauth_grants_org_user_idx" ON "oauth_grants" ("org_id","user_id");
CREATE INDEX IF NOT EXISTS "oauth_grants_client_idx" ON "oauth_grants" ("client_id");
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_hash_idx" ON "oauth_access_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_grant_idx" ON "oauth_access_tokens" ("grant_id");
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_user_idx" ON "oauth_access_tokens" ("user_id");
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_hash_idx" ON "oauth_refresh_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_grant_idx" ON "oauth_refresh_tokens" ("grant_id");
CREATE INDEX IF NOT EXISTS "oauth_audit_org_idx" ON "oauth_audit_events" ("org_id","created_at");
CREATE INDEX IF NOT EXISTS "oauth_audit_client_idx" ON "oauth_audit_events" ("client_id","created_at");
