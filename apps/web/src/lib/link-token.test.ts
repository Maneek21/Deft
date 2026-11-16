/**
 * Run: pnpm exec tsx --test apps/web/src/lib/link-token.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { captureLinkToken, readLinkToken, type LinkTokenBox } from './link-token';
import nextConfig from '../../next.config';

test('reads the token from the fragment', () => {
  assert.equal(readLinkToken('#token=abc.def.ghi'), 'abc.def.ghi');
  assert.equal(readLinkToken('token=abc'), 'abc');
  assert.equal(readLinkToken('#token=a%26b%3Dc%23d'), 'a&b=c#d');
});

test('prefers the fragment over an old-style query token', () => {
  assert.equal(readLinkToken('#token=new', '?token=old'), 'new');
});

test('falls back to an old-style ?token= link', () => {
  assert.equal(readLinkToken('', '?token=old'), 'old');
  assert.equal(readLinkToken('#other=1', 'token=old'), 'old');
});

test('returns null when no token is present', () => {
  assert.equal(readLinkToken(''), null);
  assert.equal(readLinkToken('#token=', '?token='), null);
  assert.equal(readLinkToken('#activity', '?x=1'), null);
});

/** A minimal browser address that replaceState really changes. */
function fakeBrowser(href: string) {
  const url = new URL(href, 'https://deft.test');
  const calls: string[] = [];
  const location = {
    get hash() { return url.hash; },
    get search() { return url.search; },
    get pathname() { return url.pathname; },
  };
  const history = {
    state: { kept: true } as unknown,
    replaceState(data: unknown, _unused: string, next?: string | null) {
      assert.equal(data, null, 'Next must synchronize an external history change');
      calls.push(String(next));
      const target = new URL(String(next), url);
      url.hash = target.hash;
      url.search = target.search;
      url.pathname = target.pathname;
    },
  };
  return { location, history, calls, address: () => `${url.pathname}${url.search}${url.hash}` };
}

test('captures a fragment token and strips it from the address', () => {
  for (const [href, cleanPath] of [['/invite#token=abc', '/invite'], ['/reset-password#token=abc', '/reset-password']] as const) {
    const b = fakeBrowser(href);
    const box: LinkTokenBox = { current: undefined };
    assert.equal(captureLinkToken(box, b.location, b.history, cleanPath), 'abc');
    assert.equal(b.address(), cleanPath);
  }
});

test('captures old-style links and strips them too', () => {
  const reset = fakeBrowser('/reset-password?token=old');
  assert.equal(captureLinkToken({ current: undefined }, reset.location, reset.history, '/reset-password'), 'old');
  assert.equal(reset.address(), '/reset-password');

  const invite = fakeBrowser('/invite/path-token');
  assert.equal(captureLinkToken({ current: undefined }, invite.location, invite.history, '/invite', 'path-token'), 'path-token');
  assert.equal(invite.address(), '/invite');
});

test('a missing or malformed fragment gives null and leaves the address alone', () => {
  for (const href of ['/invite', '/invite#', '/invite#token=', '/invite#tok=abc', '/reset-password#%zz']) {
    const b = fakeBrowser(href);
    assert.equal(captureLinkToken({ current: undefined }, b.location, b.history, href.split('#')[0]!), null, href);
    assert.deepEqual(b.calls, [], href);
  }
});

test('a second call (StrictMode re-running the mount effect) returns the same token', () => {
  const b = fakeBrowser('/reset-password#token=once');
  const box: LinkTokenBox = { current: undefined };
  assert.equal(captureLinkToken(box, b.location, b.history, '/reset-password'), 'once');
  assert.equal(captureLinkToken(box, b.location, b.history, '/reset-password'), 'once');
  assert.equal(b.calls.length, 1);
  assert.equal(b.address(), '/reset-password');

  const empty = fakeBrowser('/invite');
  const emptyBox: LinkTokenBox = { current: undefined };
  assert.equal(captureLinkToken(emptyBox, empty.location, empty.history, '/invite'), null);
  assert.equal(captureLinkToken(emptyBox, empty.location, empty.history, '/invite'), null);
});

test('invite and reset pages send no Referer', async () => {
  const rules = await nextConfig.headers!();
  const policyFor = (source: string) => {
    // Next applies every matching rule in order; a later key wins.
    let policy: string | undefined;
    for (const rule of rules) {
      if (rule.source !== source && rule.source !== '/(.*)') continue;
      for (const header of rule.headers) if (header.key === 'Referrer-Policy') policy = header.value;
    }
    return policy;
  };
  for (const source of ['/invite', '/invite/:path*', '/reset-password']) {
    assert.equal(policyFor(source), 'no-referrer', source);
  }
  assert.equal(policyFor('/login'), 'strict-origin-when-cross-origin');
});

// Exercise the actual component's fetch branches and rendered copy, using the
// repo's VM/hook harness pattern. This is not a mounted-browser test.
function inviteScreen(responses: Response[]) {
  const source = ts.createSourceFile('invite-accept.tsx', readFileSync(new URL('../app/invite/invite-accept.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'InviteAccept');
  assert.ok(declaration);
  const states: unknown[] = [];
  let cursor = 0;
  let effect: (() => void) | undefined;
  let effectDeps: unknown[] = [];
  const component = runInNewContext(ts.transpileModule(`(${declaration.getText(source).replace(/^export /, '')})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText, {
    React, API_URL: 'https://api.test',
    useState: (initial: unknown) => {
      const index = cursor++;
      if (index >= states.length) states.push(initial);
      return [states[index], (value: unknown) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect: (callback: () => void, deps: unknown[]) => {
      if (deps.some((value, index) => !Object.is(value, effectDeps[index]))) {
        effect = callback;
        effectDeps = [...deps];
      }
    },
    useRouter: () => ({ push: () => assert.fail('rate-limited invites must not navigate') }),
    useAuth: () => ({ refreshUser: () => assert.fail('rate-limited invites must not sign in') }),
    api: { setTokens: () => assert.fail('rate-limited invites must not set tokens') },
    Logo: () => null, Eye: () => null, EyeOff: () => null,
    fetch: async () => { const response = responses.shift(); assert.ok(response); return response; },
  }) as (props: { token: string }) => React.ReactElement;
  const view = () => { cursor = 0; return component({ token: 'synthetic-invite-token' }); };
  const find = (node: React.ReactNode, match: (element: React.ReactElement<any>) => boolean): React.ReactElement<any> | undefined => {
    if (!React.isValidElement(node)) return undefined;
    const element = node as React.ReactElement<any>;
    if (match(element)) return element;
    for (const child of React.Children.toArray(element.props.children)) {
      const found = find(child, match);
      if (found) return found;
    }
    return undefined;
  };
  return { view, find, async mount() { view(); effect!(); await new Promise(resolve => setImmediate(resolve)); } };
}

test('rate-limited invite preview asks the visitor to wait instead of replacing a valid link', async () => {
  for (const [status, code] of [[429, undefined], [400, 'RATE_LIMITED']] as const) {
    const screen = inviteScreen([Response.json({ code }, { status }), Response.json({ org_name: 'Workspace', email: 'new@test.local' })]);
    await screen.mount();
    const html = renderToStaticMarkup(screen.view());
    assert.match(html, /Too many attempts/);
    assert.match(html, /minute/);
    assert.doesNotMatch(html, /revoked|fresh link|Invite not valid/);
    screen.find(screen.view(), element => element.type === 'button')!.props.onClick();
    await screen.mount();
    assert.match(renderToStaticMarkup(screen.view()), /Join Workspace/);
  }
});

test('rate-limited invite acceptance preserves the form and shows a retry message', async () => {
  for (const [status, code] of [[429, undefined], [400, 'RATE_LIMITED']] as const) {
    const screen = inviteScreen([Response.json({ email: 'new@test.local', org_name: 'Workspace', inviter_name: 'Admin', role: 'member', already_accepted: false }), Response.json({ code }, { status })]);
    await screen.mount();
    screen.find(screen.view(), element => element.type === 'input' && element.props.type === 'password')!.props.onChange({ target: { value: 'Saved-password-2026!' } });
    await screen.find(screen.view(), element => element.type === 'form')!.props.onSubmit({ preventDefault() {} });
    const html = renderToStaticMarkup(screen.view());
    assert.match(html, /Too many attempts/);
    assert.match(html, /minute/);
    assert.doesNotMatch(html, /invalid or was revoked/);
    assert.ok(screen.find(screen.view(), element => element.type === 'form'));
    assert.match(html, /Saved-password-2026!/);
  }
});
