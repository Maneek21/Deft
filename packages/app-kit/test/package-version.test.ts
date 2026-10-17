import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {DEFT_APP_KIT_VERSION} from '../dist/index.js';
test('the public package and exported compatibility identity use the same version',()=>{
 assert.equal(DEFT_APP_KIT_VERSION,JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version);
});
