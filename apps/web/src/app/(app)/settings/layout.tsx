import styles from './settings.module.css';

export const metadata = { title: 'Settings' };

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <div className={styles.settings}>{children}</div>;
}
