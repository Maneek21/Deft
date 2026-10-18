# App release boundaries

The supported connected-App developer-preview set is Deft Host `0.3.0-preview.120` with schema 120, Email App `1.9.0-preview.13` using Author Kit `0.1.0-alpha.38`, and Email Runtime `0.4.0-preview.15` using Kit `0.1.0-alpha.35`. The different Kit versions are intentional. Obtain the exact commits, image digest, contracts, download URLs and checksums from the [published compatibility manifest](https://github.com/Maneek21/deft-email/releases/download/v1.9.0-preview.13/compatibility.json). A version label or this document alone is not evidence that an artifact has been published or accepted.

## Source and deployment ownership

| Component | Source | Owns |
| --- | --- | --- |
| Deft Host | [Maneek21/Deft](https://github.com/Maneek21/Deft): `apps/api`, `apps/web`, database/shared packages | Generic workspace identity, authorization, trusted rendering, reviewed actions, receipts, native Tasks/Knowledge and governed source navigation. |
| Author Kit | [packages/app-kit](../packages/app-kit/README.md) in Deft | Public portable contracts, package verification/building, browser SDK and Runtime transports. Versioned tarballs are independently consumable; a separate Kit repository or npm publication is not required. |
| Email App and Runtime | [Maneek21/deft-email](https://github.com/Maneek21/deft-email) | Email UI declarations and Worker, provider OAuth/custody, mailbox state, MIME, drafts, attachments, image preferences and provider effects. The Runtime is independently deployed with its own private persistent store. |

Email is the reference sideloaded connected App. It is not a built-in core mailbox product. An Email author can build and change it using the public Kit packages without a Deft source checkout, private Host imports in the build/runtime path, copied `node_modules`, Email-specific SQL or a native Email adapter. An operator still needs a compatible prebuilt Host, HTTPS, OAuth configuration, Runtime registration and current reviewed authority. Historical fixtures and source extraction provenance are not production dependencies or current install instructions.

The concrete boundary contracts are described in [App boundaries](app-boundaries.md) and the [connected App author guide](connected-app-author-guide.md). Mailbox/provider logic remains in Email; Deft exposes reusable platform capabilities.

## Reproducible public artifacts

The developer-preview publication consists of a signed/provenanced Host image and deployment assets, corresponding Host source, the independently built Email App package, Email/Runtime corresponding source archives, and immutable Kit35/Kit38 tarballs with corresponding source and SHA256 checksums. The detached `compatibility.json` release asset is the authoritative final compatibility record; it identifies immutable artifacts without requiring self-referential commit or archive hashes inside their own source.

Use the [Email README](https://github.com/Maneek21/deft-email/blob/main/README.md) for the locked public dependency install and App build, and [Email setup](https://github.com/Maneek21/deft-email/blob/main/docs/setup.md) for operator installation. The source archive includes its lockfiles and sealed Kit packages. Never rebuild a tarball under an already published immutable identity just to update prose. Local build output and private demo evidence are not substitutes for downloaded public artifacts.

The Apps-enabled release profile must compile `NEXT_PUBLIC_FEATURE_APPS`, `NEXT_PUBLIC_FEATURE_APP_RESOURCE_SYNC` and `NEXT_PUBLIC_FEATURE_APP_ATTACHMENT_BROKER` into the browser bundle. Setting environment variables only when starting a prebuilt container cannot enable omitted browser features. The release workflow checks the actual compiled profile; unrelated stable-release defaults retain their existing behavior. See [release instructions](../RELEASING.md) and [self-hosting](self-hosting.md).

Schema version, Host product version, source commit, OCI image/index digest and portable Docker image configuration ID are distinct identities. Schema120 and the required generic contracts must match the compatibility record. Fresh databases use the supported isolated bootstrap; existing installations follow the supported versioned upgrade. Neither a demo database copy nor a product tag alone proves fresh installation compatibility.

## Installation and permission boundaries

Protocol7 packages follow the public sideload stage, review and activation workflow. Stage is inspection, not execution or a permission grant. The operator separately registers the external Runtime and admits the intended connection profile. A member then connects their provider account and reviews the required resource/data/action access. Deft validates current identity, scope, lifecycle and reviewed bindings before granting access or executing an action.

Provider credentials and Email encryption keys remain in the Runtime's private operator configuration and persistent custody. They do not belong in App manifests, Workers, public source archives or compatibility files. An App receives neither an owner Web token nor unrestricted workspace access.

Human consent, trusted Experience disclosure and technical channel leases are separate. Explicit signed policies can support reviewed **Until revoked** account, draft-store and metadata grants. Initial enrollment and review/technical requests remain finite; null or omitted expiry alone is not consent. Technical renewal checks current membership, scope and custody, and does not approve a message. Sending requires the exact saved sender, recipients, content and files to be reviewed through the current action binding. Revocation ends subsequent access; uncertain outcomes are inspected rather than automatically replayed.

Email-to-Task and Email-to-Knowledge use generic governed source publication and destination review. Background metadata/capture authority is distinct from foreground mailbox reading. A functioning reader alone does not establish automatic Knowledge capture, Task publication or permission to disclose message contents to another audience.

## Acceptance and preview limits

Release acceptance combines exact artifact/CI/provenance checks with a bounded consumer and live journey: an Apps-enabled Host, clean independent Email build, connected Gmail reading and HTML/images, saved/reopened attachment draft, one reviewed send with independent recipient verification, Task/source return, restart retention and an Email-only upgrade while the Host remains unchanged. Reuse earlier evidence only when its artifact identities and covered behavior still apply; label older receipts as historical.

This preview demonstrates a functioning connected App and its platform integrations. It does not claim production-grade Gmail/Outlook parity, effortless onboarding, broad provider certification, production scale or a product-wide latency SLO. Refresh can remain slow; operator enrollment, partial-access messaging, narrow newsletter rendering and browser PDF-preview limitations are disclosed in the [Email limitations](https://github.com/Maneek21/deft-email/blob/main/docs/limitations.md). Accepted defects never include unauthorized disclosure, duplicate-send risk, data loss or a broken documented installation path.

Future Email scope is maintained in the separate [Email roadmap](https://github.com/Maneek21/deft-email/blob/main/ROADMAP.md). New mailbox providers or shared inbox workflows belong to that independent app, using reusable Deft capabilities.

The [preview16 boundary note](history/app-release-boundaries-preview16.md) is preserved as historical evidence of the earlier monorepo WIP. Its versions, account/attachment limits, ownership and acceptance statements are not current guidance.
