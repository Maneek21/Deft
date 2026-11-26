# Build your first app

For Deft v0.3.0-preview.155.

## Before you start

You need a Deft workspace and an owner or admin account. Hosted workspaces need nothing else: everything below happens in the browser. An app adds your own record types, fields, links and views to the workspace (boards, tables, forms and record pages). It holds data and views only: it runs no code of its own and does not connect to outside services.

Workspace members can see and change every record in an app. Guests can't see apps at all. Use the fictional sample data below, not private business records.

## 1. Start from a starter app

Open **Settings → Apps**. Under **Start from a template**, choose **Vendor tracker**. Keep the name, or type your own, leave **Add a few sample records so you can see how it works** ticked, and choose **Install Vendor tracker**.

The starter installs as your own app, so you can change it later. If the name is already taken, Deft adds " 2" to it.

**Check:** the app appears under **Installed** and in the sidebar. Open it: it opens on a board grouped by status, with two vendors. Open **Contracts** and check that **Acme Hosting annual plan** links to **Acme Hosting**.

## 2. Add a record

Choose **New vendor** and create **Example Studio** with the contact email `hello@example.com`. Then open **Contracts**, choose **New contract**, name it **Studio retainer** and pick **Example Studio** under **Vendor**.

**Check:** the contract shows its vendor, and the vendor's page lists the contract. To link a task, open **Draft the launch checklist** from the [workspace tutorial](first-workspace.md) and use its **References** tab to attach **Example Studio**. Return to the vendor and confirm the task appears under **Linked tasks**.

## 3. Change the app in the browser

Back in **Settings → Apps**, choose **Edit** on the Vendor tracker card. The editor shows the app file: plain JSON that lists record types (`collections`), their fields and their views. Add a field to the Vendors `fields` list, after `notes`:

```json
{ "key": "account_number", "label": "Account number", "type": "text" }
```

Choose **Check**. Deft checks the file the way it will when you save and explains any problem in plain words, naming where it is. Then choose **Save**. You don't need to change the version: Deft raises it for you.

**Check:** the message says the app is now version 1.0.1 and every record was kept, and new vendors offer an **Account number** field.

An update keeps every record. If a change would break a record that already exists, for example making a field required while some records leave it empty, Deft refuses the update and names those records, so you can fix them first. If someone else saved the app after you opened the editor, Save is refused; load the newest version and make your change again.

## 4. Upload an app file

You can also write an app file yourself, in any text editor, and upload it. Download the [example app file](../examples/vendor-pilot/deft.module.json): it describes **Vendor pilot**, with Vendors and Services and a link from each service to its vendor. Its id is `community.example.vendor-pilot`, its slug is `vendor-pilot`, and its version is `0.1.0`.

In **Settings → Apps**, choose **Upload an app** and pick the file; any `.json` name works. Deft reads it in the browser first. If something is wrong, you get the same plain-words lines as in the editor, and nothing is sent. Otherwise **Check before installing** shows what the app adds: each record type, its fields, how record types link and its views. It also asks **Let Defty read these records?** (No is the default). Choose **Install Vendor pilot**.

To update an app you wrote, change the file, raise its version (for example to `0.1.1`), and choose **Upload new version** on its card. Keep the id and slug the same; they can't change.

Add this line at the top of your file and editors such as VS Code check it as you type:

```json
{ "$schema": "https://deft.ing/schemas/deft.module.v1.schema.json" }
```

## 5. Defty, agents and MCP

Each app card has a **Defty and agents** setting: **No access**, **Read**, or **Read and write**. It starts at **No access** unless you said yes when installing. Defty and agent employees can only use an app at the level you choose, and their writes wait for approval. Defty also needs an AI provider configured for the workspace.

A personal MCP connection acts as you, so it doesn't use this setting. It needs the `read:modules` scope to read app records, and `write:modules` to change them.

## 6. Turn off, not delete

**Turn off** on an app's card hides it and keeps every record; **Turn on** brings it back. An installed app can't be deleted, and its id and slug stay taken. Names that belong to apps that ship with Deft, such as `contacts` or ids starting `com.deft.` or `io.deft.`, can't be used.

## Self-hosted: build the file from the Deft source

On a self-hosted install you can use the steps above, or scaffold and check app files from the command line. You need Node.js 22.13 or newer and pnpm 11.10.0:

```bash
git clone --branch v0.3.0-preview.155 --depth 1 https://github.com/Maneek21/Deft.git deft-module-source
cd deft-module-source
pnpm install --frozen-lockfile
pnpm module:init ../my-first-app
pnpm module:check ../my-first-app
```

`module:init` needs a new or empty folder and creates `deft.module.json` with a schema file beside it. `module:format` tidies the file, and `module:check` validates it and prints its digest; run them from the Deft source folder. Then upload `deft.module.json` with **Upload an app** as in step 4.

## Next

The [app file reference](https://deft.ing/docs/modules/) lists every field type, view and limit. [Apps and App packages](../modules-and-apps.md) explains what an app is at this release, and where App packages fit.
