import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDiscussionTaskCommand } from '../src/workers/handlers/agent-reply.js';

test('discussion task command accepts explicit discussion-to-task prompts', () => {
  assert.equal(
    isDiscussionTaskCommand('Defty, read this thread and create a task for the resolved buyer-label blocker.'),
    true,
  );
  assert.equal(
    isDiscussionTaskCommand('Can you summarize the conversation above into tasks for the launch team?'),
    true,
  );
  assert.equal(
    isDiscussionTaskCommand('Turn this chat into one ticket with the final resolution and owner.'),
    true,
  );
});

test('discussion task command rejects negated task creation prompts', () => {
  assert.equal(
    isDiscussionTaskCommand('Please summarize this discussion, but do not create tasks yet.'),
    false,
  );
  assert.equal(
    isDiscussionTaskCommand("Don't make todos from this conversation; I only need a recap."),
    false,
  );
  assert.equal(
    isDiscussionTaskCommand('Avoid opening tickets from the thread until Maya confirms scope.'),
    false,
  );
});

test('discussion task command does not treat ordinary task chatter as a command', () => {
  assert.equal(isDiscussionTaskCommand('I created the task from the greenhouse conversation.'), false);
  assert.equal(isDiscussionTaskCommand('Please create a task called "Check crates" in the packing project.'), false);
  assert.equal(isDiscussionTaskCommand('This discussion was useful.'), false);
});
