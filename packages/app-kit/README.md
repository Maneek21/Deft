# `@deft/app-kit`

Portable, deterministic authoring contract for declarative Deft apps.

App Protocol v0 composes one or more declarative Module v1 manifests into a
single integrity-checked package. Parsing a package proves structure and
artifact integrity only. Installation, authorization, permissions, tenant
isolation, and full Module validation remain host responsibilities.

App Protocol v1 is an authoring-only connected contract in this release. It
adds exact App dependencies, Module resource/field requirements, one private
sandbox-email capability, an existing MCP-connector requirement, and closed
host-rendered action bindings. It does not grant authority, create a connector,
or enable execution. Hosts reject v1 inspection/staging until the corresponding
grant and lifecycle substrate is installed.

Private interface keys are always relative to the immutable workspace App
lineage selected by the host. An App id, repository, publisher label, or other
package-authored text cannot choose that authority namespace.

The v1 action source language is intentionally closed: declared resource
fields, one selected declared relation target, or explicit typed user input.
Templates, JSONPath, arbitrary transforms, scripts, URLs, environment values,
secrets, automation, runtimes, sync, custom UI, and public ingress are not part
of this protocol.
