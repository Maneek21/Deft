# Connected Resource Campaigns App

- Build only through the public App Protocol v1 and declarative Module v2
  contracts.
- Preserve the App and Module lineage inherited from the Resource Campaigns v0
  predecessor; this directory is its reviewed connected upgrade proof.
- Keep the Contacts dependency exact and use only the frozen private sandbox
  email interface with an existing MCP connector selected by the host.
- Do not add executable code, dynamic loading, App-controlled policy, connector
  creation, custom UI, public routes, sync, schedules, or automation.
- Build with the public `@deft/app-kit` CLI and preserve deterministic package
  and lock-file bytes.
