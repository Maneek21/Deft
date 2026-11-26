# Apps and App packages

For Deft v0.3.0-preview.155.

An **app** is what you install, build, and turn on or off in Deft. It adds record types, fields, links and views (boards, tables, timelines, forms and record pages) to your workspace. You describe it in one **app file**, `deft.module.json`. "Module" is the name of that file format in the code and on the command line; everything you see in Deft calls it an app.

An **App package** (`deft.app.json`, built with App Kit) is a different format. It wraps app files and can ask for connected actions that need a reviewed runtime. At this release App packages are for Deft's own Email; build your own app as an app file.

## Choose what you need

| You want to… | Use | Where |
|---|---|---|
| Track vendors, candidates, content or other records your team shares | An app: start from a starter app, or upload an app file | **Settings → Apps**: **Start from a template**, or **Upload an app** |
| Change an app you installed | The app's file | **Edit** on its card in **Settings → Apps**, or **Upload new version** |
| Add Email to the workspace | Deft's Email App package | Its own release and install guide |

Follow [Build your first app](tutorials/first-module.md) for the whole path, from a starter app to editing in the browser and uploading your own file. The [app file reference](https://deft.ing/docs/modules/) lists every field type, view and limit.

## What an app can and can't do

An app holds data and views. It can't run code of its own, add custom screens or buttons, send email, run on a schedule, or connect to outside services.

An update keeps every record. Deft refuses an update that would break a record that already exists, and names the records that stand in the way. The app's id and slug can't change.

An installed app can be turned off, which hides it and keeps its records, but not deleted. Its id and slug stay taken. Names that belong to apps that ship with Deft, such as `contacts` or any id starting `com.deft.` or `io.deft.`, can't be used, and an App package can't carry an app that ships with Deft.

## App packages at this release

App packages are for Deft's own Email at launch, and we don't recommend building your own yet:

- A basic App package you build yourself (App Protocol 0, records and views only) can be staged and turned on, but **it can't be upgraded yet**: Deft refuses another version of it, and it can't be uninstalled. Changing it means starting a new App with a new id. Connected packages have a separate, reviewed upgrade flow for operators.
- Apps are off by default on a self-hosted install, and developer pairing is off on hosted workspaces.
- Asking for a permission is a request for review, not a grant. A connected package is staged first; an owner or admin reviews it, binds an eligible provider, and activates it.

For the Email App, use the [Email reference implementation](https://github.com/Maneek21/deft-email) and the versions in the `compatibility.json` attached to the Email release you install. The [App author guide](connected-app-author-guide.md) and [App Run operations guide](app-run-operations.md) cover packages and their runtime for operators.

## Know who can access the records

Workspace owners, admins and members can see and change every record in an app. Guests can't see apps at all. There are no private records, record types or fields.

Only owners and admins install, update and turn off apps.

A new app gives Defty and agent employees no access until an owner or admin chooses **Read** or **Read and write** under **Defty and agents** on its card, or answers yes to "Let Defty read these records?" when installing it. Defty's changes in chat wait for approval; an agent employee's changes follow its trust level; and a request to archive a record always needs a person's review.

Personal MCP clients act as the connected person and need the `read:modules` and `write:modules` scopes. The **Defty and agents** setting doesn't control them.

"AI client" elsewhere in the docs means an external tool such as Claude or Codex connected through MCP. It is separate from an app installed in Deft.
