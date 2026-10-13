import test from 'node:test';
import assert from 'node:assert/strict';
import {createAttachmentZip,attachmentArchiveFilename} from './app-experience-attachment-zip';
import {createAttachmentZip as nativeZip,attachmentArchiveFilename as nativeFilename} from './email-attachment-zip';
test('retained Email imports and generic controls share the same unchanged ZIP implementation',()=>{assert.equal(createAttachmentZip,nativeZip);assert.equal(attachmentArchiveFilename,nativeFilename);assert.deepEqual(createAttachmentZip([{filename:'../safe.txt',bytes:new Uint8Array([0,255])}]),nativeZip([{filename:'../safe.txt',bytes:new Uint8Array([0,255])}]));});
