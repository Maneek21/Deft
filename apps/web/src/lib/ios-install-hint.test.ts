import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IOS_INSTALL_HINT_DISMISSED_KEY,
  isIphoneSafari,
  readIosInstallHintDismissed,
  rememberIosInstallHintDismissed,
  shouldShowIosInstallHint,
} from './ios-install-hint';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1';
const IPHONE_FIREFOX = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15';
const IPHONE_IN_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0';
const IPAD_SAFARI = 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

test('only iPhone Safari counts as iPhone Safari', () => {
  assert.equal(isIphoneSafari(IPHONE_SAFARI), true);
  for (const ua of [IPHONE_CHROME, IPHONE_FIREFOX, IPHONE_IN_APP, IPAD_SAFARI, MAC_SAFARI, ANDROID_CHROME]) {
    assert.equal(isIphoneSafari(ua), false, ua);
  }
});

test('the hint shows on iPhone Safari when not installed and not dismissed', () => {
  assert.equal(shouldShowIosInstallHint({ userAgent: IPHONE_SAFARI, dismissed: false }), true);
  assert.equal(shouldShowIosInstallHint({ userAgent: IPHONE_SAFARI, navigatorStandalone: false, displayModeStandalone: false, dismissed: false }), true);
});

test('the hint stays hidden once installed, once dismissed, and on other browsers', () => {
  assert.equal(shouldShowIosInstallHint({ userAgent: IPHONE_SAFARI, navigatorStandalone: true, dismissed: false }), false);
  assert.equal(shouldShowIosInstallHint({ userAgent: IPHONE_SAFARI, displayModeStandalone: true, dismissed: false }), false);
  assert.equal(shouldShowIosInstallHint({ userAgent: IPHONE_SAFARI, dismissed: true }), false);
  assert.equal(shouldShowIosInstallHint({ userAgent: ANDROID_CHROME, dismissed: false }), false);
  assert.equal(shouldShowIosInstallHint({ userAgent: IPHONE_CHROME, dismissed: false }), false);
});

test('dismissal is remembered and storage failures never throw', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  assert.equal(readIosInstallHintDismissed(storage), false);
  rememberIosInstallHintDismissed(storage);
  assert.equal(values.get(IOS_INSTALL_HINT_DISMISSED_KEY), '1');
  assert.equal(readIosInstallHintDismissed(storage), true);

  const broken = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  assert.equal(readIosInstallHintDismissed(broken), false);
  assert.doesNotThrow(() => rememberIosInstallHintDismissed(broken));
  assert.equal(readIosInstallHintDismissed(null), false);
});
