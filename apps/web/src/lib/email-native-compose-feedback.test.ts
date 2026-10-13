import assert from 'node:assert/strict';import test from 'node:test';
import {nativeComposeFeedback,nativeSignatureFeedback,nativeSendCancelledNotice} from './email-native-compose-feedback';
test('original file controls replace obsolete blanket copy, preserving quoted truncation and errors',()=>{
 const note='Review the recipients and message before sending. Original attachments are not included until you choose Include selected originals. Only part of the original message is quoted.';
 assert.equal(nativeComposeFeedback(note,true),'Review before sending. Only part of the original message is quoted.');assert.match(nativeComposeFeedback(note,false),/Original attachments are not included/);assert.equal(nativeComposeFeedback('A file could not be saved.',true),'A file could not be saved.');
});
test('passive signature load footer disappears while actual problems and cancellation stay visible',()=>{
 assert.equal(nativeSignatureFeedback('Signature preferences loaded. Existing message text is kept. Use More to insert a signature.'),'');assert.equal(nativeSignatureFeedback('Saved signature added. Review it before sending.'),'Signature added.');assert.equal(nativeSignatureFeedback('Signatures could not be loaded. Your draft is kept.'),'Signatures could not be loaded. Your draft is kept.');assert.match(nativeSendCancelledNotice,/cancelled.*draft.*edit/);
});
