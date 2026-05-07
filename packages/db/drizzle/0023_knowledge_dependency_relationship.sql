-- Add unique constraint on people_relationships (user_a_id, user_b_id, relationship_type)
-- so that ON CONFLICT DO UPDATE upserts work correctly for knowledge_dependency edges.
ALTER TABLE "people_relationships"
  ADD CONSTRAINT "people_relationships_pair_type_unique"
    UNIQUE ("user_a_id", "user_b_id", "relationship_type");
