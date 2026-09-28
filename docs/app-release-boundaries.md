# App release boundaries

The `0.3.0-preview.16` Deft host and `0.1.0-alpha.6` Author Kit are candidates
with publication pending. Email `1.5.4` is a WIP example. These identities do
not claim a published image, npm package, external mail delivery, or production
mailbox certification.

## Source ownership

| Artifact | Source | Role |
|---|---|---|
| Deft host | `apps/api`, `apps/web`, database/shared packages | Generic workspace, authorization, consent, Run lifecycle, receipts and App host behavior. |
| Author Kit | `packages/app-kit` | Portable versioned contracts, package CLI and browser Experience SDK. Its host compatibility must match the candidate source. |
| Email WIP | `examples/apps/email` | Independently buildable author and provider example using public Kit exports. Mail specific behavior belongs here. |

All three source boundaries currently belong to the Deft repository. There is
no separate Email or Author Kit repository established by this preparation.
Existing independent Contacts module distribution remains separate.

The Kit has its own version. Schema migrations have their existing versioned
identities through `0.3.0-preview.56`; these are schema steps, not evidence that
intermediate product releases were published. Existing deployments follow
`pnpm db:upgrade`, while fresh disposable schemas use `pnpm db:push-full`.

## Portable candidate packaging

From the exact reviewed source checkout:

```sh
pnpm --dir packages/app-kit pack --pack-destination /absolute/path/to/artifacts
```

The resulting candidate is `deft-app-kit-0.1.0-alpha.6.tgz`. Record its SHA256,
retain that exact artifact, and install it in a clean author directory. Verify
the public root and browser leaf exports and the `deft` CLI there. Do not use a
workspace link, private host imports, or a changed artifact under the same
published version. No npm publication is claimed or performed by packing.

The Email README provides its exact candidate consumer installation and build
steps. Generated bundles, App packages, node_modules, local tarballs and test
reports are build outputs. Preserve their provenance externally rather than
mixing private execution evidence into the public example source.

## Operator boundary and WIP limits

Building an Email App does not authorize installation, access to a mailbox,
private disclosure, or sending. An operator supplies a separate mail account
configuration, reviews installation and resource custody, issues purpose
specific Runtime credentials, and grants the supported Experience consent and
agent policy. Each external write still needs the exact host review required
by the current binding. Author code does not receive an owner Web token.

Terminal sync Runs do not automatically retry an observation. An authenticated
current owner can request `resume-observation` for the exact terminal predecessor
and current binding. It retains the checkpoint, cursor, projections and original
unknown outcome; a new observation gets its own Run and receipts. Current
consent, session and cadence checks still apply. Staged predecessor work is
rejected for manual investigation. This route does not retry an Email send,
replace an unknown effect with a known failure, or grant new custody.

The local proof used synthetic contacts and owned loopback TLS IMAP/SMTP. It
observed two distinct personalized messages, SMTP and Sent-copy acceptance,
exact Run receipts, and no duplicate effects on replay. This validates the
tested fixture path. It does not establish recipient delivery or fresh
production setup against a real account. Email remains WIP until those product
and operational requirements receive their own evidence.

This example supports one account and one recipient per invocation, plain text,
and no outgoing attachments. Its private draft limit is 32 records, including
submitted drafts, with 30 day retention. Archive uses the legacy human approval
flow. Provider operation and recovery currently need the documented development
supervisor and manual operational steps. Real provider setup and everyday mail
client behavior remain unproven. Native tool executor and MCP campaign proofs
do not establish a new full Defty model turn for the campaign.

Core App Runtime, attachment/resource custody, private state, private Defty
context, Experience disclosure, and related public capabilities retain their
default off feature flags. Enable only the explicit supported subset with its
reviewed operator setup; the WIP example does not change these defaults.

## Release preparation

Feature and example PRs can be reviewed independently using their declared
dependencies, but a public host release must contain matching Kit contracts
and the supported schema upgrades. Keep candidate changelog notes under
Unreleased and use the `core` release scope unless separately certified
integration evidence exists. Follow [RELEASING.md](../RELEASING.md) for required
checks. Merge, annotated tag, image publication, registry publication, and
GitHub release publication are separate actions from this preparation.

Email 1.5.4 is a built fresh-install candidate; the existing preview remains on 1.5.3. Historical unknown sync outcomes can block upgrades, and a complete normal owner reconciliation flow for those outcomes is still missing. Do not remove or rewrite historical outcomes to permit an upgrade.
