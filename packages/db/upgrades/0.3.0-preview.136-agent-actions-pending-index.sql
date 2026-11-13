-- Pending-approval reads (Inbox approvals, Attention backfill) filter one
-- workspace's pending agent actions and order them by creation time.
-- Plain CREATE INDEX: the upgrade runner applies each file inside one
-- transaction with its ledger row, where CONCURRENTLY is not allowed. No
-- IF NOT EXISTS: a same-named index left over from elsewhere (for example an
-- interrupted concurrent build) fails the upgrade instead of being recorded.
CREATE INDEX agent_action_pending_org_created_idx
  ON public.agent_actions (org_id, created_at)
  WHERE approval_status = 'pending';
