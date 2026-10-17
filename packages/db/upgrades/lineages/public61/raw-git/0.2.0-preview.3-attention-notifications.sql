CREATE TABLE IF NOT EXISTS attention_items (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  lane text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  state text NOT NULL DEFAULT 'open_unseen',
  dedupe_key text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_event_id text,
  title text NOT NULL,
  body text,
  link text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  due_at timestamp,
  urgent_at timestamp,
  last_event_at timestamp NOT NULL DEFAULT now(),
  event_count integer NOT NULL DEFAULT 1,
  version integer NOT NULL DEFAULT 1,
  seen_at timestamp,
  acknowledged_at timestamp,
  snoozed_until timestamp,
  resolved_at timestamp,
  resolution text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS attention_item_user_dedupe_unique ON attention_items (org_id, user_id, dedupe_key);
CREATE INDEX IF NOT EXISTS attention_item_user_state_idx ON attention_items (org_id, user_id, state, last_event_at);
CREATE INDEX IF NOT EXISTS attention_item_user_lane_idx ON attention_items (org_id, user_id, lane, last_event_at);
CREATE INDEX IF NOT EXISTS attention_item_source_idx ON attention_items (org_id, source_type, source_id);

CREATE TABLE IF NOT EXISTS attention_events (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  attention_item_id text NOT NULL REFERENCES attention_items(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  source_event_id text NOT NULL,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attention_event_item_idx ON attention_events (attention_item_id, created_at);
CREATE INDEX IF NOT EXISTS attention_event_user_idx ON attention_events (org_id, user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS attention_event_source_unique ON attention_events (org_id, user_id, source_event_id, event_type);

CREATE TABLE IF NOT EXISTS attention_deliveries (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  attention_item_id text NOT NULL REFERENCES attention_items(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  delivery_version integer NOT NULL DEFAULT 1,
  attempt_count integer NOT NULL DEFAULT 0,
  provider_message_id text,
  last_error text,
  next_attempt_at timestamp,
  sent_at timestamp,
  delivered_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS attention_delivery_version_unique ON attention_deliveries (attention_item_id, channel, delivery_version);
CREATE INDEX IF NOT EXISTS attention_delivery_queue_idx ON attention_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS attention_delivery_user_idx ON attention_deliveries (org_id, user_id, created_at);

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  endpoint_hash text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  device_name text,
  user_agent text,
  is_active boolean NOT NULL DEFAULT true,
  failure_count integer NOT NULL DEFAULT 0,
  last_used_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS web_push_subscription_endpoint_hash_unique ON web_push_subscriptions (endpoint_hash);
CREATE INDEX IF NOT EXISTS web_push_subscription_user_idx ON web_push_subscriptions (org_id, user_id, is_active);

CREATE TABLE IF NOT EXISTS agent_action_approvers (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  action_id text NOT NULL REFERENCES agent_actions(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision text NOT NULL DEFAULT 'pending',
  decided_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_action_approver_unique ON agent_action_approvers (action_id, user_id);
CREATE INDEX IF NOT EXISTS agent_action_approver_user_idx ON agent_action_approvers (org_id, user_id, decision);

-- Existing pending approvals belong to their active human requester. Actions
-- without one are operational orphans and fall back to active org operators.
INSERT INTO agent_action_approvers (id, org_id, action_id, user_id)
SELECT gen_random_uuid()::text, aa.org_id, aa.id, u.id
FROM agent_actions aa
JOIN users u
  ON u.id = COALESCE(
    aa.params->>'source_user_id',
    aa.params->>'origin_user_id',
    aa.user_id
  )
JOIN org_members om
  ON om.org_id = aa.org_id
  AND om.user_id = u.id
  AND om.is_active = true
WHERE aa.approval_status = 'pending'
  AND aa.approval_tier IN ('quick', 'full')
  AND u.is_agent = false
  AND u.kind = 'human'
ON CONFLICT (action_id, user_id) DO NOTHING;

INSERT INTO agent_action_approvers (id, org_id, action_id, user_id)
SELECT gen_random_uuid()::text, aa.org_id, aa.id, om.user_id
FROM agent_actions aa
JOIN org_members om
  ON om.org_id = aa.org_id
  AND om.is_active = true
  AND om.role IN ('owner', 'admin')
WHERE aa.approval_status = 'pending'
  AND aa.approval_tier IN ('quick', 'full')
  AND NOT EXISTS (
    SELECT 1
    FROM users u
    JOIN org_members requester_om
      ON requester_om.org_id = aa.org_id
      AND requester_om.user_id = u.id
      AND requester_om.is_active = true
    WHERE u.id = COALESCE(
      aa.params->>'source_user_id',
      aa.params->>'origin_user_id',
      aa.user_id
    )
      AND u.is_agent = false
      AND u.kind = 'human'
  )
ON CONFLICT (action_id, user_id) DO NOTHING;
