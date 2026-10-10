/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./app.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["'DM Sans'", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [require("daisyui")],
  daisyui: {
    themes: [
      {
        finance: {
          primary: "#0d9488",
          "primary-content": "#ffffff",
          secondary: "#64748b",
          accent: "#0f766e",
          neutral: "#44403c",
          "base-100": "#ffffff",
          "base-200": "#fafaf9",
          "base-300": "#f5f5f4",
          "base-content": "#1c1917",
          info: "#0ea5e9",
          success: "#059669",
          warning: "#d97706",
          error: "#dc2626",
        },
      },
    ],
  },
};

