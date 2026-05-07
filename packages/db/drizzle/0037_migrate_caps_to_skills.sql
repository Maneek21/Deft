-- Task 4.4 — Migrate agent_employees.capability_packs[] into the
-- agent_employee_skills junction.
--
-- Prior to Phase 4 the capability packs installed on an employee were
-- stored inline as a text[] column. Phase 4 promotes packs to bundled
-- skills (see migration 0036 + seed-bundled-skills.ts). This one-shot
-- migration copies every existing (employee, pack) pair into the
-- junction table, joining against skills.slug to resolve the bundled
-- skill id.
--
-- The dual-read shim in apps/api/src/workers/handlers/deploy-provision.ts
-- unions both sources during the transitional period, so dropping the
-- legacy column is explicitly deferred to Task 4.12 once every
-- deployment path has switched over.
--
-- ON CONFLICT DO NOTHING keeps the migration idempotent: re-applying is a
-- no-op. Pre-requisite: seed-bundled-skills.ts has been run so the
-- target skill rows exist.

INSERT INTO agent_employee_skills (agent_employee_id, skill_id, installed_at, installed_version)
SELECT ae.id, s.id, COALESCE(ae.created_at, NOW()), s.version
FROM agent_employees ae
CROSS JOIN LATERAL unnest(ae.capability_packs) AS pack_slug
JOIN skills s ON s.source = 'bundled' AND s.slug = pack_slug AND s.is_deleted = false
ON CONFLICT (agent_employee_id, skill_id) DO NOTHING;
