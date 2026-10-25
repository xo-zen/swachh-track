import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: { extend: { colors: { ink: '#172c29', ivory: '#f7f8f2', civic: '#08775d' } } },
  plugins: [],
} satisfies Config;
