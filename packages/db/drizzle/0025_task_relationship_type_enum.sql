DO $$ BEGIN
  CREATE TYPE task_relationship_type AS ENUM ('blocks','blocked_by','relates_to','duplicates');
EXCEPTION WHEN duplicate_object THEN null; END $$;

UPDATE task_relationships SET type = 'relates_to' WHERE type NOT IN ('blocks','blocked_by','relates_to','duplicates');

ALTER TABLE task_relationships ALTER COLUMN type TYPE task_relationship_type USING type::task_relationship_type;
