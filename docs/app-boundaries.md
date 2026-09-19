# Deft, App Kit and domain Apps

Deft owns authentication, tenant isolation, native storage and rendering,
resource permissions, approvals, effective connector grants and execution.
`@deft/app-kit` is a build-time authoring contract: it validates and packages
declarations, but never grants their requested authority. A domain App such as
CRM owns collections, business fields, relationships, view configuration and
requested actions. It uses the same host interfaces as another sideloaded App.

## Author and host contract

- Use the exact packed Kit artifact supported by the destination host. The
  candidate Kit is `0.1.0-alpha.3`; published preview.15 uses `0.1.0-alpha.2`.
  Preserve the artifact and generated consumer lockfile. Changed contracts must
  receive a new Kit version before distribution.
- Keep the App's version distinct from its embedded Module versions. All build
  paths for the same release must produce the same package identity. Connected
  upgrades require a strictly newer App version than the active base.
- App navigation selects a collection and optionally one of that collection's
  declared views. Invalid references fail validation; the host carries valid
  `view_key` declarations into links.
- Deft adds **Linked tasks** alongside authored navigation. This is a native
  resource integration for all Modules; it creates no domain records and grants
  no additional task access. Existing `workspace=follow-ups` links remain valid.
- Icon tokens and fallback behavior are documented in the portable
  [App Kit README](../packages/app-kit/README.md#host-presentation-and-access).
  Tokens cannot carry markup or external URLs.

## Authority and execution

Package validity, installation, granted access and successful execution are
separate states. Operators choose compatible connectors and effective grants.
Deft checks live authority again at action preparation, invocation, approval
and execution. An App cannot choose its own tenant, private authority namespace,
provider credentials or approval result.

The current connected contract is the closed sandbox-email interface. Other
capabilities require a host contract implementation and conformance evidence;
arbitrary MCP tools, executable App scripts and custom App UI are not enabled by
this package format. Sandbox acceptance does not establish external delivery.

Module data currently uses workspace-level permissions. Business fields such
as Owner do not define row or field ACLs. Defty and agent employees obey Module
agent-access policy. Personal MCP clients act as the authorizing human and obey
that user's access and the token scopes. Native linked tasks retain their own
visibility rules. See [assistant setup](crm-ai-assistants.md).

The browser is part of the tenant boundary too: cached data must remain scoped
to the authenticated session, including account changes and late requests.
Realtime invalidation must target that same scope.
