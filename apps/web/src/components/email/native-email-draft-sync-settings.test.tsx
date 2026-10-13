import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {NativeEmailDraftSyncSettings} from './native-email-draft-sync-settings';
test('real draft-sync setting defaults off, names account-scoped intent and promises no provider import',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailDraftSyncSettings,{accountId:'a',provider:'gmail',sessionScope:'session'}));
 assert.match(html,/Sync Deft drafts to provider/);assert.match(html,/Off by default/);assert.match(html,/does not import all existing provider drafts/);assert.match(html,/Save draft sync choice/);assert.doesNotMatch(html,/checked=""|border-b|Exposure|25 fields/);
 const source=readFileSync(new URL('./native-email-draft-sync-settings.tsx',import.meta.url),'utf8');assert.match(source,/setUncertain\(true\)/);assert.match(source,/if\(!saved\|\|working\|\|uncertain/);assert.match(source,/expected_revision:saved.revision/);
});
test('Microsoft reports bounded support while the choice remains disabled until fresh saved permission is known',()=>{
 const html=renderToStaticMarkup(createElement(NativeEmailDraftSyncSettings,{accountId:'a',provider:'microsoft',sessionScope:'session'}));assert.match(html,/up to 3 MiB/);assert.match(html,/uncertain changes are not repeated automatically/);assert.match(html,/disabled=""/);assert.doesNotMatch(html,/checked=""|not available yet/);
});
