# Connect your first AI client

For Deft v0.3.0-preview.15.

## Choose the identity

A personal MCP connection acts as **you**. It can access only what your account and granted scopes allow. It does not create an agent employee.

Start with read access. Personal write-enabled connections can change data without entering Defty's approval queue.

## 1. Create the connection

Sign in to Deft and open **Settings → MCP Access**. Choose the client you use and follow its connection instructions. Prefer OAuth when supported; otherwise create a scoped personal token and store it in the client's credential settings.

The endpoint is `https://your-deft.example.com/api/mcp/v1`. Use the URL shown by your installation. A hosted client needs a reachable HTTPS deployment; it cannot access a server running only on your laptop's localhost.

Grant `read:workspace` and `read:tasks` for this exercise. See the guides for [Claude.ai](https://deft.ing/docs/claude-online/), [Claude Desktop](https://deft.ing/docs/claude-desktop/), [Claude Code](https://deft.ing/docs/claude-code/), or [Cursor and Codex](https://deft.ing/docs/cursor-codex/) for client-specific setup.

## 2. Test a read

Ask the client:

> List my tasks in Deft. Include each task's title, status, and task key. Do not change anything.

Compare one result with the same task in Deft. If you followed the workspace tutorial, look for **Draft the launch checklist**.

**Check:** the client returns real tasks you can open, with matching details. An empty result may be correct if your account has no assigned tasks or cannot access that project.

## 3. Add writes only when needed

If you want task creation, add `write:tasks` through the connection's supported grant flow. Then ask for one clearly named test task in a specific project and verify it in Deft. The write runs with your authority; it is not waiting for an employee approval card.

Developers can follow the [MCP task example](mcp-task-example.md) for exact tool arguments and retry behavior.

## 4. Revoke the connection

Return to **Settings → MCP Access** and revoke the test connection when finished. Try another task read from the client: it should require a new authorization or fail authentication.

If the connection fails, check the endpoint, token or OAuth grant, required scopes, and network reachability. Keep tokens out of prompts and support screenshots.
