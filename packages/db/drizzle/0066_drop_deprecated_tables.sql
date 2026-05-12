-- Deprecated 2026-04-16, cleanup deadline 2026-05-16.
-- Reads migrated to wiki_pages in Phase 2 (Tasks 2.2 + 2.3).
-- Deprecation-warning cron reported zero new rows for 30 days.
-- Live writes (add_knowledge, link_decision_to_tasks, mark_decision_implemented,
-- weekly-digest decision listing) were rewired to wiki_pages on 2026-05-12.

DROP TABLE IF EXISTS space_knowledge CASCADE;
DROP TABLE IF EXISTS decisions CASCADE;

-- The knowledge_type pgEnum was only referenced by space_knowledge.type.
-- Drop the type so the schema and DB stay in sync.
DROP TYPE IF EXISTS knowledge_type;
