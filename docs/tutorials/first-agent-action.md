# Your first approved agent action

For Deft v0.3.0-preview.155.

## Before you start

Use the `launch-room` space and **Launch pilot** project from [Your first workspace](first-workspace.md). An owner or admin needs to configure a working provider in **Settings → AI configuration**.

In chat, Defty proposes a task for your approval at every trust level; the workspace trust level applies only to plans Defty runs in the background. This tutorial uses Defty; a personal MCP client writes as its connected user and does not use the same approval queue.

## 1. Ask for a specific task

In `launch-room`, type `@` and select **Defty** from mention autocomplete. Send:

> Create a task in Launch pilot called “Review the launch announcement”. Assign it to me and make it due tomorrow. Include this checklist in the description: check the date, test the demo link, and confirm the support contact.

If Defty asks which project or person you mean, select the intended match. It should draft the task rather than guess between similar names.

## 2. Review the proposal

Wait for the approval card. Check the title, project, assignee, due date, and description before choosing **Create task**. Pay attention to the actual calendar date when you used “tomorrow”.

If something is wrong, choose **Dismiss** and send a corrected request. A pending proposal is not a completed task.

## 3. Check what changed

Open **Launch pilot** and find **Review the launch announcement**. Confirm its owner, date, and checklist match the approved proposal. An owner or admin can read the completed action's receipt under **Settings → Policies & audit** (**View receipt**) and follow the task link when one is shown.

**Success means both are present:** the saved task and the completed action record. A reply saying “done” alone is not enough.

For a recorded example, watch [the task-and-approval chapter](https://youtu.be/7z9EH4c9k2o?t=126). The video uses seeded demo data; your task and project names will differ.

## 4. Try rejecting a proposal

Ask Defty to create another task named **Approval practice — reject this**. Choose **Dismiss** on its card, then check that the task was not created. This gives you a simple check of both outcomes before assigning real work.

## If it does not work

| What happened | What to check |
|---|---|
| No response | Confirm the provider works and Defty was selected from mention autocomplete. |
| Task appeared without review | Confirm the request went to Defty and not to a personal MCP client or an agent employee, which follow their own rules. |
| Approval exists but no task appears | Check the action status and error details before submitting the request again. |
| Wrong project or owner | Dismiss the draft and use the exact project name or person's email in the next request. |

See [Approval rails](https://deft.ing/docs/approval-rails/) for policy details. To let a personal AI client use the workspace, follow [Connect your first AI client](first-mcp-connection.md).
