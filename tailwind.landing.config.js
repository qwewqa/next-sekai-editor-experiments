const { boxShadow, colors } = require('./tailwind.colors')

// The landing pages' own config: their classes only, with the editor's colours and shadows.
/** @type {import('tailwindcss').Config} */
module.exports = {
    future: {
        hoverOnlyWhenSupported: true,
    },
    content: {
        relative: true,
        files: [
            './app/index.html',
            './privacy/index.html',
            './terms/index.html',
            './src/landing/**/*.{ts,css}',
        ],
    },
    theme: {
        extend: {
            colors,
            boxShadow,
        },
    },
    plugins: [require('./tailwind.controls')],
}
