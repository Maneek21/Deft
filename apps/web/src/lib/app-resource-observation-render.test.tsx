import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ExperienceBackgroundRefreshReview} from '../components/apps/experience-background-refresh-review';
const now=Date.now(),review={account:{label:'Synthetic account'},interval_seconds:900,expires_at:new Date(now+60000).toISOString()} as any;
const render=(time:number)=>renderToStaticMarkup(createElement(ExperienceBackgroundRefreshReview,{review,now:time,busy:false,onAllow:()=>assert.fail('No implicit activation'),onCheck:()=>{},onClose:()=>{}}));
test('actual review names account, interval, expiry, no files/drafts/Send and explicit human allow',()=>{const html=render(now);assert.match(html,/Synthetic account/u);assert.match(html,/15 minutes/u);assert.match(html,/Files and attachments are not downloaded/u);assert.match(html,/does not permit draft changes, sending/u);assert.match(html,/No personal sign-in token/u);assert.match(html,/Allow background refresh/u);assert.match(html,/does not enable background refresh/u);});
test('expired actual review renders status recovery and never enables an old review',()=>{const html=render(now+60001);assert.match(html,/review expired/u);assert.match(html,/Check status/u);assert.doesNotMatch(html,/>Allow background refresh<\/button/u);});
