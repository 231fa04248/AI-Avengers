/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: { ink: '#0b1630', mist: '#f5f7fb', teal: '#10b981', amber: '#f59e0b' },
      boxShadow: { soft: '0 18px 60px rgba(11, 22, 48, 0.08)' },
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] }
    }
  },
  plugins: []
};
