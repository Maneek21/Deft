# Build your first Module

For Deft v0.3.0-preview.15.

## Before you start

You need a preview.15 workspace, an owner or admin account, Node.js 22.13 or newer, and pnpm 11.10.0. This tutorial creates a declarative Module with vendors and related services. It does not need the experimental App Kit or a provider connection.

Module records are visible to ordinary workspace members. Use the fictional sample data below, not private business records.

## 1. Scaffold the Module

Run from a parent directory in Bash:

```bash
git clone --branch v0.3.0-preview.15 --depth 1 https://github.com/Maneek21/Deft.git deft-module-source
cd deft-module-source
pnpm install --frozen-lockfile
pnpm module:init ../deft-module-vendor-pilot
```

The destination must be new or empty. The scaffold creates `deft.module.json` and supporting authoring files.

## 2. Add vendors and services

Download the [complete example manifest](../examples/vendor-pilot/deft.module.json) and save it over `../deft-module-vendor-pilot/deft.module.json`.

The manifest declares two collections:

| Collection | Fields | Purpose |
|---|---|---|
| Vendors | Required name, email, notes | Stores each vendor once. |
| Services | Required name, vendor relation | Links a service to its vendor. |

Each collection has Table, Form, and Details views. `search.title_field` identifies the display name; `search.fields` lists the fields to search. The relation's `target_collection: "vendors"` points to the Vendors collection.

The Module id is `community.example.vendor-pilot`, its slug is `vendor-pilot`, and its first version is `0.1.0`. Keep the id and slug unchanged when upgrading it.

## 3. Validate it

Run from the Deft source directory:

```bash
pnpm module:format ../deft-module-vendor-pilot
pnpm module:check ../deft-module-vendor-pilot
```

The check should exit successfully and print a digest. If it reports a bad reference, compare every view field and relation target with the keys declared in the manifest. Fix the reported problem before installation.

## 4. Install and create sample records

Open **Settings → Modules**, choose **Install local**, and upload `deft.module.json`. Review the identity and collections, then choose **Confirm install**.

Open **Vendor pilot** in workspace navigation. Create a vendor named **Example Studio** with email `hello@example.com`. In Services, create **Launch illustrations**, then open the saved record. Under **Related records → Vendor**, choose **Edit**, select **Example Studio**, and **Save**. Relations are added after record creation.

**Check:** both records appear in their collections, and the service links to the correct vendor. To link a task, open **Draft the launch checklist** from the workspace tutorial and use its **References** tab to attach **Example Studio**. Return to the vendor record and confirm the task appears under **Linked tasks**.

Agent access starts at `none`. Leave it there for this exercise. This setting controls Defty and agent employees. Personal MCP connections use your account's permissions and need the corresponding Module scopes.

## 5. Try a small upgrade

Change the manifest version to `0.1.1` and change its description. Format and check it again, then choose **Update local manifest** on its card in Settings → Modules. Upload the revised file, check the version and digest against the CLI output, and choose **Confirm update**.

**Check:** the active version is `0.1.1` and both sample records remain. Larger field changes must also validate the existing records; changing the schema does not make incompatible data disappear.

## Next

Read the [Module reference](https://deft.ing/docs/modules/) for supported fields, views, and access limits. [Modules and Apps](../modules-and-apps.md) explains the separate package and review flow for supported connected actions.
