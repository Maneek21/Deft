# Scheduled Connected Resource Campaigns App

- Build only through public App Protocol v2, Module v2, and App Kit contracts.
- Preserve the existing App/Module lineage, exact Contacts dependency, action binding, and provider interface.
- Keep the automation declaration requested-only. Never add schedule values, resource ids, providers, policy, approval, secrets, or executable code to the App package.
- Use the public simulator for deterministic schedule and pin checks; it never grants authority or invokes a provider.
- Do not add workflows, custom UI, runtimes, sync, public routes, or Deft core branches.
