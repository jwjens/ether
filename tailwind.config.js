/** @type {import("tailwindcss").Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: { extend: { colors: {
    "on-air": "#ef4444", "cued": "#22c55e", "automation": "#3b82f6"
  }}},
  plugins: [],
};
