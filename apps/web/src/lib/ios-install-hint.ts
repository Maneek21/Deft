/**
 * Decides when to show the "Add to Home Screen" instruction to iPhone users.
 *
 * Safari on iPhone never offers an install prompt, and web notifications work
 * there only once Deft has been added to the Home Screen. So the hint is shown
 * only on iPhone Safari, only when Deft is not already running from the Home
 * Screen, and never again once dismissed.
 */
export const IOS_INSTALL_HINT_DISMISSED_KEY = 'deft-ios-install-hint-dismissed';

export type IosInstallHintEnvironment = {
  userAgent: string;
  /** `navigator.standalone` (Safari only); true when launched from the Home Screen. */
  navigatorStandalone?: boolean;
  /** `matchMedia('(display-mode: standalone)').matches`. */
  displayModeStandalone?: boolean;
  dismissed: boolean;
};

// Other browsers on iPhone carry "Safari" in their user agent too; each adds
// its own token.
const NON_SAFARI_IOS_TOKENS = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|GSA\/|FBAN|FBAV|Instagram|Line\/|Twitter|Snapchat|LinkedInApp|wv\)/;

export function isIphoneSafari(userAgent: string): boolean {
  if (!/iPhone|iPod/.test(userAgent)) return false;
  if (!/Safari\//.test(userAgent) || !/Version\//.test(userAgent)) return false;
  return !NON_SAFARI_IOS_TOKENS.test(userAgent);
}

export function shouldShowIosInstallHint(env: IosInstallHintEnvironment): boolean {
  if (env.dismissed) return false;
  if (env.navigatorStandalone === true || env.displayModeStandalone === true) return false;
  return isIphoneSafari(env.userAgent);
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readIosInstallHintDismissed(storage: StorageLike | null | undefined): boolean {
  try {
    return storage?.getItem(IOS_INSTALL_HINT_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberIosInstallHintDismissed(storage: StorageLike | null | undefined): void {
  try {
    storage?.setItem(IOS_INSTALL_HINT_DISMISSED_KEY, '1');
  } catch {
    // Private mode or blocked storage: the hint simply returns next visit.
  }
}
