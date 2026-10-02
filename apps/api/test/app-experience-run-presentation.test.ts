import test from 'node:test';
import assert from 'node:assert/strict';
import { experienceRunState } from '../src/lib/app-experience-run-presentation.js';
test('only released approval projects as queued; unapproved human and agent requests retain approval',()=>{
 assert.equal(experienceRunState('pending_approval','approved'),'pending');
 assert.equal(experienceRunState('pending_approval',null),'pending_approval');
 assert.equal(experienceRunState('pending_approval','policy'),'pending_approval');
 assert.equal(experienceRunState('running','approved'),'running');
 assert.equal(experienceRunState('succeeded','approved'),'succeeded');
});
