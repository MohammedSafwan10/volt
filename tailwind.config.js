/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  theme: {
    extend: {
      colors: {
        // Catppuccin Mocha-inspired theme
        bg: {
          DEFAULT: '#1e1e2e',
          sidebar: '#181825',
          panel: '#1e1e2e',
          header: '#181825',
          input: '#313244',
        },
        text: {
          DEFAULT: '#cdd6f4',
          secondary: '#a6adc8',
          disabled: '#585b70',
        },
        accent: {
          DEFAULT: '#89b4fa',
        },
        success: {
          DEFAULT: '#a6e3a1',
        },
        warning: {
          DEFAULT: '#f9e2af',
        },
        error: {
          DEFAULT: '#f38ba8',
        },
        border: {
          DEFAULT: '#313244',
        },
        hover: {
          DEFAULT: '#313244',
        },
        active: {
          DEFAULT: '#45475a',
        },
        // Surface colors
        surface: {
          0: '#313244',
          1: '#45475a',
          2: '#585b70',
        },
        // Overlay colors
        overlay: {
          0: '#6c7086',
          1: '#7f849c',
          2: '#9399b2',
        },
        // Syntax highlighting colors
        pink: '#f5c2e7',
        mauve: '#cba6f7',
        red: '#f38ba8',
        maroon: '#eba0ac',
        peach: '#fab387',
        yellow: '#f9e2af',
        green: '#a6e3a1',
        teal: '#94e2d5',
        sky: '#89dceb',
        sapphire: '#74c7ec',
        blue: '#89b4fa',
        lavender: '#b4befe',
      },
    },
  },
  plugins: [],
};
