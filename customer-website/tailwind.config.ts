import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{astro,html,ts,tsx}'],
  darkMode: ['variant', '&:where(.dark, .dark *)'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      colors: {
        // semantic tokens — read from CSS vars so light/dark switch works automatically
        surface: {
          lowest: 'var(--surface-lowest)',
          dim: 'var(--surface-dim)',
          DEFAULT: 'var(--surface)',
          'container-low': 'var(--surface-container-low)',
          container: 'var(--surface-container)',
          'container-high': 'var(--surface-container-high)',
          'container-highest': 'var(--surface-container-highest)',
          variant: 'var(--surface-variant)',
          bright: 'var(--surface-bright)',
        },
        ink: {
          DEFAULT: 'var(--on-surface)',
          variant: 'var(--on-surface-variant)',
          outline: 'var(--outline)',
          'outline-variant': 'var(--outline-variant)',
        },
        primary: {
          DEFAULT: 'var(--primary)',
          container: 'var(--primary-container)',
          on: 'var(--on-primary)',
          'on-container': 'var(--on-primary-container)',
        },
        tertiary: 'var(--tertiary)',
        status: {
          red: 'var(--status-red)',
          amber: 'var(--status-amber)',
          green: 'var(--status-green)',
          blue: 'var(--status-blue)',
          gray: 'var(--status-gray)',
        },
        ghost: 'var(--ghost-border)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        glass: '0 8px 24px rgba(0, 0, 0, 0.4)',
      },
      backdropBlur: {
        glass: '12px',
      },
    },
  },
  plugins: [],
} satisfies Config;
