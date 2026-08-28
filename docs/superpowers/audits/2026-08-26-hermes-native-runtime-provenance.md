# Hermes native runtime provenance

**Date:** 2026-08-26
**Scope:** Development pin for the native integration bundle. The release gate
must independently reproduce this pin from a clean upstream checkout.

```text
distribution: hermes-agent
version: 0.20.5
repository: https://github.com/NousResearch/hermes-agent.git
ref: refs/tags/v2026.8.19
commit: fcbd1076a93841fa88855acce810e342a5b78101
```

The local audited profile reported Hermes `0.20.5` / `2026.8.19`, and the tag
resolved to the commit above. Its profile interpreter passed the Deft native
adapter suite 12/12. This record selects the runtime to reproduce; it is not a
substitute for the clean-checkout, commit-bound release certificate.

## Revalidation — 2026-08-27

The same profile interpreter and clean pinned checkout were revalidated after
native recovery hardening:

```text
command: C:\tmp\hermes-venv-fcbd1076\Scripts\python.exe -m unittest integrations.hermes.deft-platform.test_deft_platform -v
result: Ran 24 tests; OK
runtime version: 0.20.5
peeled ref commit: fcbd1076a93841fa88855acce810e342a5b78101
upstream worktree: clean (0 changed or untracked files)
```

This local revalidation remains supporting evidence only. The release workflow
must reproduce the pin and suite from the exact release tag before publication.
