/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "Noto Sans JP", "system-ui", "sans-serif"],
        jp: ["Noto Sans JP", "Hiragino Sans", "Meiryo", "sans-serif"],
      },
    },
  },
  plugins: [],
};
