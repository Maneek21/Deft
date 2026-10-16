# Generic installed-App menus

Accepted for implementation; deployment and live acceptance remain separate.

A renderer-v2 `menu.v1` node supplies a bounded inert menu declaration. The
Host mounts its existing shared AppMenu through the renderer enhancement seam,
including the mobile bottom sheet. No App identifier, domain action, provider,
URL or executable author content selects Host behavior.

Each flat item is a current-view control with a globally unique ID. Selection
uses the existing click event and existing print-control binding. Disabled and
stale-view callbacks fail closed. Menu items carry no permission or effect
authority; all existing action, custody, review and access checks remain.

Kit alpha36 publishes the contract and helper. Required capability negotiation
makes older Hosts refuse it explicitly. The new Host retains alpha35 package
compatibility, so it can be deployed before the author upgrades its App.

Reuse shared overlay keyboard/dismissal/focus/mobile behavior. Keep main-view
menus separate from preferences until that surface has a menu mount adapter.
