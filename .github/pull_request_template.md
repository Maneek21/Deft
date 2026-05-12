## Summary

<!-- 1-3 sentences. What does this change and why? -->

## Type

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Docs only
- [ ] CI / tooling

## Test plan

<!-- How did you verify this works? -->

## Checklist

- [ ] `pnpm -r typecheck` passes
- [ ] If touching the API: relevant tests under `apps/api/test/` pass
- [ ] If touching the schema: migration is idempotent and added to the journal
- [ ] If touching the agent: action goes through the approval flow where required
- [ ] No secrets, keys, or `.env` content committed

## Related issues

<!-- Closes #X, fixes #Y, refs #Z -->
