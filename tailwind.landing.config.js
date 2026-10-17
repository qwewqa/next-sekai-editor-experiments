const { boxShadow, colors } = require('./tailwind.colors')

// The landing pages' own config (Part 5, 5.1.2): their classes only, with the editor's colours and shadows.
/** @type {import('tailwindcss').Config} */
module.exports = {
    future: {
        hoverOnlyWhenSupported: true,
    },
    content: ['./app/index.html', './privacy/index.html', './src/landing/**/*.{ts,css}'],
    theme: {
        extend: {
            colors,
            boxShadow,
        },
    },
}
