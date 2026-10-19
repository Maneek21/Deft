import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleListControlsHref, moduleSearchHref, moduleSearchValue, reconcileModuleSearch, type ModuleSearchBuffer } from './module-search-buffer';
import { parseModuleListContext } from './module-list-context';
const identity = 'session-a:contacts:contacts';
test('sequential Review survives delayed URL observations between characters', () => {
  let buffer: ModuleSearchBuffer = { identity, value: '' };
  let browser = new URL('https://deft.invalid/modules/contacts/contacts?view=table&filters=%5B%5D&keep=1#results');
  const delayed: string[] = [];
  for (const character of 'Review') {
    const next = moduleSearchValue(buffer, identity, browser.searchParams.get('q') ?? '') + character;
    delayed.push(browser.searchParams.toString()); buffer = { identity, value: next };
    browser = new URL(moduleSearchHref(browser.href, next), browser);
    for (const oldQuery of delayed) buffer = reconcileModuleSearch(buffer, identity, new URLSearchParams(oldQuery).get('q') ?? '', oldQuery, browser.searchParams.toString());
    assert.equal(moduleSearchValue(buffer, identity, ''), next);
  }
  assert.equal(buffer.value, 'Review'); assert.equal(browser.searchParams.get('q'), 'Review');
  assert.equal(browser.searchParams.get('view'), 'table'); assert.equal(browser.searchParams.get('filters'), '[]');
  assert.equal(browser.searchParams.get('keep'), '1'); assert.equal(browser.pathname, '/modules/contacts/contacts'); assert.equal(browser.hash, '#results');
});
test('external URL, Back and Forward queries are authoritative', () => {
  let buffer = { identity, value: 'Review' };
  for (const value of ['External', '', 'Review']) { const query = new URLSearchParams(value ? { q:value } : {}).toString(); buffer = reconcileModuleSearch(buffer, identity, value, query, query); assert.equal(buffer.value, value); }
});
test('collection and session changes never render prior search', () => {
  const buffer = { identity, value:'Review' };
  for (const next of ['session-a:contacts:deals', 'session-b:contacts:contacts']) {
    assert.equal(moduleSearchValue(buffer, next, 'Reloaded'), 'Reloaded');
    assert.deepEqual(reconcileModuleSearch(buffer, next, 'Reloaded', 'q=Reloaded', 'q=Reloaded'), {identity:next,value:'Reloaded'});
  }
});
test('clear removes only q and retains filters, saved view and sort', () => {
  const url = new URL(moduleSearchHref('https://deft.invalid/modules/contacts/contacts?q=Review&saved=mine&filters=%5B%5D&sort=name&direction=asc', ''), 'https://deft.invalid');
  assert.equal(url.searchParams.has('q'), false); assert.equal(url.searchParams.get('saved'), 'mine'); assert.equal(url.searchParams.get('sort'), 'name'); assert.equal(url.searchParams.get('direction'), 'asc'); assert.equal(url.searchParams.get('filters'), '[]');
});
test('full query input, reload and existing query bound are retained', () => {
  const href = moduleSearchHref('https://deft.invalid/modules/contacts/contacts?view=table', 'LIVE126-261019 Review Contact');
  const loaded = { identity, value:new URL(href, 'https://deft.invalid').searchParams.get('q') ?? '' };
  assert.equal(moduleSearchValue(loaded, identity, ''), 'LIVE126-261019 Review Contact');
  assert.equal(new URL(moduleSearchHref('https://deft.invalid/modules/contacts/contacts', 'x'.repeat(501)), 'https://deft.invalid').searchParams.get('q')?.length, 500);
});

test('rapid Active filter then Name A-Z sort preserves both without a React acknowledgement', () => {
 let browser=new URL('https://deft.invalid/modules/contacts/contacts?view=table&q=Review&keep=1#records');
 const oldRender=parseModuleListContext(browser.searchParams);
 browser=new URL(moduleListControlsHref(browser.href,{filters:[{field:'status',operator:'eq',value:'active'}]}),browser);
 // No render/prop update occurs between the two independent input events.
 assert.deepEqual(oldRender.filters,[]);
 browser=new URL(moduleListControlsHref(browser.href,{sort:{field:'name',direction:'asc'}}),browser);
 const settled=parseModuleListContext(browser.searchParams);
 assert.deepEqual(settled.filters,[{field:'status',operator:'eq',value:'active'}]);
 assert.deepEqual(settled.sort,{field:'name',direction:'asc'});assert.equal(settled.search,'Review');
 assert.equal(browser.searchParams.get('view'),'table');assert.equal(browser.searchParams.get('keep'),'1');assert.equal(browser.hash,'#records');
});
test('settled filter/sort and query interaction survive reload and Back/Forward URLs', () => {
 const initial='https://deft.invalid/modules/contacts/contacts?view=table';
 const filtered=new URL(moduleListControlsHref(initial,{filters:[{field:'status',operator:'eq',value:'active'}]}),initial);
 const sorted=new URL(moduleListControlsHref(filtered.href,{sort:{field:'name',direction:'desc'}}),initial);
 const typed=new URL(moduleSearchHref(sorted.href,'Review'),initial);
 assert.deepEqual(parseModuleListContext(typed.searchParams).filters,parseModuleListContext(filtered.searchParams).filters);
 for(const href of [typed.href,filtered.href,typed.href]) {
  const current=new URL(href);const next=new URL(moduleListControlsHref(current.href,{search:'Reloaded'}),current);
  assert.deepEqual(parseModuleListContext(next.searchParams).filters,[{field:'status',operator:'eq',value:'active'}]);
  assert.equal(parseModuleListContext(next.searchParams).sort?.direction,current.searchParams.get('direction')??undefined);
 }
});
test('saved view defaults remain absent until explicit filter clear, and clear all is atomic', () => {
 const initial='https://deft.invalid/modules/contacts/contacts?saved=mine&keep=1&q=Review';
 const sorted=new URL(moduleListControlsHref(initial,{sort:{field:'name',direction:'asc'}}),initial);
 assert.equal(sorted.searchParams.has('filters'),false);
 const cleared=new URL(moduleListControlsHref(sorted.href,{search:'',filters:[],sort:undefined}),initial);
 assert.equal(cleared.searchParams.get('saved'),'mine');assert.equal(cleared.searchParams.get('filters'),'[]');
 assert.equal(cleared.searchParams.has('q'),false);assert.equal(cleared.searchParams.has('sort'),false);assert.equal(cleared.searchParams.has('direction'),false);assert.equal(cleared.searchParams.get('keep'),'1');
});
test('new collection URL does not inherit prior collection controls', () => {
 const current='https://deft.invalid/modules/contacts/deals?view=table&keep=other';
 const next=new URL(moduleListControlsHref(current,{sort:{field:'value',direction:'desc'}}),current);
 assert.equal(next.pathname,'/modules/contacts/deals');assert.equal(next.searchParams.has('filters'),false);assert.equal(next.searchParams.has('q'),false);assert.equal(next.searchParams.get('keep'),'other');
});
