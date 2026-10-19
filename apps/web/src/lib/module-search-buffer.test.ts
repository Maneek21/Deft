import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleSearchHref, moduleSearchValue, reconcileModuleSearch, type ModuleSearchBuffer } from './module-search-buffer';
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
