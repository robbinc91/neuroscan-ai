/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./*.{ts,tsx}",
        "./components/**/*.{ts,tsx}",
        "./utils/**/*.{ts,tsx}",
        "./services/**/*.{ts,tsx}"
    ],
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                gray: {
                    750: '#2d3748',
                    850: '#1a202c',
                    950: '#0d1117',
                },
                cyan: {
                    450: '#00a3c4',
                }
            },
            fontFamily: {
                sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
                mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', 'monospace'],
            }
        }
    },
    plugins: [],
}
