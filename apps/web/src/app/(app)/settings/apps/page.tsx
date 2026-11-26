import { AppsClient } from './apps-client';

// The Apps page is always on: apps in the module format need no feature flag.
// App Kit packages appear on it only when NEXT_PUBLIC_FEATURE_APPS is on.
export default function AppsPage() {
  return <AppsClient />;
}
