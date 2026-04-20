-- Self-hosted v1 — add ON DELETE CASCADE to the two user FKs that block
-- user deletion outright.
--
-- Surfaced during live-testing the single-org hard-block cleanup: trying
-- to DELETE a user row hit foreign_key_violation 23503, because both
-- onboarding_state.user_id and org_members.user_id referenced users(id)
-- without CASCADE. The admin-facing "remove member" flow is also
-- affected.
--
-- Scope is deliberately narrow: these two tables are strictly user-owned
-- (per-user onboarding progress + per-user org membership). Every other
-- user FK in the schema — authorship, creator columns, etc. — needs a
-- case-by-case review (CASCADE vs SET NULL) and is not touched here.

ALTER TABLE onboarding_state
  DROP CONSTRAINT IF EXISTS onboarding_state_user_id_users_id_fk;

ALTER TABLE onboarding_state
  ADD CONSTRAINT onboarding_state_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE org_members
  DROP CONSTRAINT IF EXISTS org_members_user_id_users_id_fk;

ALTER TABLE org_members
  ADD CONSTRAINT org_members_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
