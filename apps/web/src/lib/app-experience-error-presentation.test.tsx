import assert from 'node:assert/strict';
import test from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {AppRequestNotice,appRequestNoticeParts} from '../components/apps/app-request-notice';

test('Host errors lead with plain language, one action, and collapsed diagnostic details',()=>{
 const html=renderToStaticMarkup(<AppRequestNotice message="The app is temporarily unavailable. Try again shortly. (APP_RUNTIME_UNAVAILABLE; EXAMPLE_RUNTIME_UNAVAILABLE)" action={<button>Try again</button>}/>);
 assert.match(html,/<p role="alert"[^>]*>The app is temporarily unavailable\. Try again shortly\.<\/p>/);
 assert.equal((html.match(/<button/g)??[]).length,1);
 assert.match(html,/<details[^>]*><summary[^>]*>Details<\/summary><p[^>]*>APP_RUNTIME_UNAVAILABLE; EXAMPLE_RUNTIME_UNAVAILABLE<\/p><\/details>/);
 assert.doesNotMatch(html,/<details[^>]* open/);
});

test('only generated Host diagnostic suffixes fold; arbitrary messages stay literal text',()=>{
 assert.deepEqual(appRequestNoticeParts('Open the app (work account)'),{message:'Open the app (work account)'});
 assert.deepEqual(appRequestNoticeParts('The app did not start. (APP_EXPERIENCE_STARTUP_FAILED: first_view)'),{message:'The app did not start.',details:'APP_EXPERIENCE_STARTUP_FAILED: first_view'});
 const html=renderToStaticMarkup(<AppRequestNotice message={'A failure <script>private</script> (untrusted)'}/>);
 assert.ok(html.includes('&lt;script&gt;private&lt;/script&gt;'));
 assert.doesNotMatch(html,/<details/);
});


test('generic data and runtime failures use plain language while retaining diagnostic codes',()=>{
 assert.deepEqual(appRequestNoticeParts('App data request unavailable (APP_PROVIDER_UNAVAILABLE)'),{message:'The app data is temporarily unavailable. Try again shortly.',details:'APP_PROVIDER_UNAVAILABLE'});
 assert.equal(appRequestNoticeParts('The app Runtime is unavailable (APP_RUNTIME_UNAVAILABLE; EXAMPLE_RUNTIME_UNAVAILABLE)').message,'The app is temporarily unavailable. Try again shortly.');
});
