import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appIntegrationSourceHref} from './app-integration-source-navigation.js';
const href='/apps/00000000-0000-4000-8000-000000000001/main?account_ref=account_a&source_store_key=drafts&source_resource_key=inbox&source_record_id=00000000-0000-4000-8000-000000000002&source_digest=sha256:'+'a'.repeat(64);
test('source navigation accepts only Host current installed source nomination, rejects author URLs and extra authority',()=>{
 assert.equal(appIntegrationSourceHref({href}),href);
 for(const bad of ['https://evil.test'+href,'//evil.test'+href,href+'&session_id=expired',href+'#authority',href.replace('source_digest','old_digest'),href.replace('source_store_key=drafts','source_store_key=__proto__'),href.replace('source_resource_key=inbox','source_resource_key=https%3Aevil'),'/settings'])assert.equal(appIntegrationSourceHref({href:bad}),null);
 assert.equal(appIntegrationSourceHref({href,principal:'author'}),null);
});

test('cached native recovery navigation is exact and adds no authority',()=>{const recovery='/apps/recovery/native-email/native_account?message=mail_'+'a'.repeat(64);assert.equal(appIntegrationSourceHref({href:recovery}),recovery);for(const bad of [recovery+'&message=mail_'+'b'.repeat(64),recovery+'&scope=owner',recovery.replace('?message=','?%6dessage='),recovery.replace('mail_a','mail_%61'),recovery+'&',recovery+'#grant',recovery.replace('mail_','draft_'),recovery.replace('native_account','native%2Faccount'),'//evil.test'+recovery,recovery.replace('recovery/native-email','recovery/other')])assert.equal(appIntegrationSourceHref({href:bad}),null);});
