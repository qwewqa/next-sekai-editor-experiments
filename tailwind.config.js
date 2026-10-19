const { boxShadow, colors } = require('./tailwind.colors')

/** @type {import('tailwindcss').Config} */
module.exports = {
    // Touch screens must not keep hover styles after a tap.
    future: {
        hoverOnlyWhenSupported: true,
    },
    content: ['./index.html', './src/**/*.vue', './src/**/*.ts'],
    theme: {
        extend: {
            colors,
            boxShadow,
            width: {
                screen: ['100vw', '100dvw'],
            },
            height: {
                screen: ['100vh', '100dvh'],
            },
        },
    },
    plugins: [require('./tailwind.controls')],
}
