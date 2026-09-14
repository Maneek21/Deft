# Keeping documentation current

## Ownership

Keep deployment contracts, schemas, runnable examples, and tutorial source in this repository. The website presents those instructions with search and navigation. Historical plans and audits stay under `docs/superpowers/`; they are not setup guides.

The tutorial Markdown in `docs/tutorials/` is canonical. The website's `scripts/sync-product-docs.mjs` copies it into the documentation layout and copies the example downloads. Run the script with a checkout containing the reviewed documentation changes, then build and check the website. Do not maintain two independent tutorial drafts.

## Writing

- Lead with what the reader will accomplish.
- Name the starting state, required role, and relevant release.
- Use actual UI labels and commands from that release.
- Put a short expected result after each important action.
- Explain the likely failure next to the step it affects.
- Prefer one example over a long feature list. Link to reference details.
- Label illustrative output and demo screenshots. Do not imply they came from the reader's workspace.

## Before a release

1. Check the image tag and digest, downloaded asset names, and required secrets.
2. Follow the recommended fresh-install path in a disposable deployment.
3. Create a task and attachment. Back up, restore into a separate project, and verify both.
4. Rehearse the supported upgrade from its declared baseline. Record the previous and target image digests.
5. Check personal MCP scopes, an authenticated read, a write, and a retry with the same idempotency key.
6. Validate the example Module, install it, create its records, and test its upgrade.
7. Update changed limits, flags, client compatibility, and runtime certification statements.
8. Sync the website tutorials, build it, check links, and inspect desktop and mobile navigation.

Run `pnpm docs:check` for local links, the Module example, and operational scripts with a simulated Docker command. The tests cover restart behavior, failure handling, legacy uploads, checksums, target collisions, and successful restore commands. They require Bash and do not replace a real install or restore test.

In the website checkout, run `pnpm docs:sync --check /path/to/Deft` to compare against the reviewed source. The normal website build also checks synced-file integrity, release consistency, search behavior, rendered command/download parity, and local links. Synchronization refuses a tutorial that targets a different release from the site configuration.

## Record the evidence

For each workflow, record the release/commit, environment, command or user actions, result, and remaining limitation. Say “targets this release” when only source was checked. Reserve “verified” for an actual recorded run. Update the website release badge only after the release exists and its instructions are reviewed.
