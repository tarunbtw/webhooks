/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        background:       'hsl(var(--background))',
        foreground:       'hsl(var(--foreground))',
        muted:            'hsl(var(--muted))',
        'muted-foreground': 'hsl(var(--muted-foreground))',
        border:           'hsl(var(--border))',
        input:            'hsl(var(--input))',
        ring:             'hsl(var(--ring))',
        card: {
          DEFAULT:     'hsl(var(--card))',
          foreground:  'hsl(var(--card-foreground))',
        },
        accent: {
          DEFAULT:     'hsl(var(--accent))',
          foreground:  'hsl(var(--accent-foreground))',
        },
        primary: {
          DEFAULT:     'hsl(var(--primary))',
          foreground:  'hsl(var(--primary-foreground))',
        },
        destructive: {
          DEFAULT:     'hsl(var(--destructive))',
          foreground:  'hsl(var(--destructive-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
}
