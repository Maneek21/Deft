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
