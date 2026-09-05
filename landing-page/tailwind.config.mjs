/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: {
        '2xl': '1280px',
      },
    },
    extend: {
      fontFamily: {
        // The desktop app's own two faces. `display` is deliberately the same
        // family as `sans`: this product's personality is carried by setting
        // real Unity identifiers in `mono` at display size, not by a second
        // sans shipped for headlines.
        sans: ['Instrument Sans', 'ui-sans-serif', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['Instrument Sans', 'ui-sans-serif', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          lit: 'hsl(var(--gold-lit))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },

        // The surface ramp, named for what it is rather than for a role.
        void: 'hsl(var(--void))',
        sunk: 'hsl(var(--sunk))',
        panel: 'hsl(var(--panel))',
        raised: 'hsl(var(--raised))',
        selected: 'hsl(var(--selected))',
        bright: 'hsl(var(--bright))',

        // Semantic. Only ever used where the colour IS the meaning.
        pass: 'hsl(var(--pass))',
        warn: 'hsl(var(--warn))',
        fail: {
          DEFAULT: 'hsl(var(--fail))',
          text: 'hsl(var(--fail-text))',
        },
        info: 'hsl(var(--info))',

        // Syntax, for code surfaces only.
        syn: {
          keyword: 'hsl(var(--syn-keyword))',
          string: 'hsl(var(--syn-string))',
          number: 'hsl(var(--syn-number))',
          type: 'hsl(var(--syn-type))',
          func: 'hsl(var(--syn-func))',
          comment: 'hsl(var(--syn-comment))',
        },

        'navy-deep': 'hsl(var(--navy-deep))',
        'surface-elevated': 'hsl(var(--surface-elevated))',
      },
      borderRadius: {
        // Differential, from the app: 3px chips, 6px panels, 10px large planes.
        // The old config mapped everything off a single 12px `--radius`, which
        // is what makes a page read as one rounded-card kit.
        chip: 'var(--radius-chip)',
        panel: 'var(--radius-panel)',
        plane: 'var(--radius-plane)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 3px)',
      },
      fontSize: {
        // A 1.5-ish scale off a 16px body, per Elements of Typographic Style.
        micro: ['11px', { lineHeight: '1.45' }],
        mini: ['13px', { lineHeight: '1.5' }],
        base: ['16px', { lineHeight: '1.6' }],
        step1: ['20px', { lineHeight: '1.45', letterSpacing: '-0.005em' }],
        step2: ['28px', { lineHeight: '1.25', letterSpacing: '-0.015em' }],
        step3: ['40px', { lineHeight: '1.12', letterSpacing: '-0.022em' }],
        step4: ['60px', { lineHeight: '1.02', letterSpacing: '-0.03em' }],
        step5: ['84px', { lineHeight: '0.97', letterSpacing: '-0.035em' }],
      },
      keyframes: {
        // `float`, `float-slow`, `drift`, `typing-cursor`, `slide-up`,
        // `pulse-glow` and `count-up` were removed: every one was either
        // unreferenced config or belonged to the drifting-glyph hero that this
        // redesign deletes. The fade-ins stay because /features still uses them.
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-left': {
          from: { opacity: '0', transform: 'translateX(-20px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'fade-in-right': {
          from: { opacity: '0', transform: 'translateX(20px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.55s cubic-bezier(0.16, 1, 0.3, 1) both',
        'fade-in-left': 'fade-in-left 0.55s cubic-bezier(0.16, 1, 0.3, 1) both',
        'fade-in-right': 'fade-in-right 0.55s cubic-bezier(0.16, 1, 0.3, 1) both',
        'scale-in': 'scale-in 0.45s cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
