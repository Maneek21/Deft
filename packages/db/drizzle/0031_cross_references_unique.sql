CREATE UNIQUE INDEX IF NOT EXISTS cross_references_quad_idx ON cross_references(source_type, source_id, target_type, target_id);
