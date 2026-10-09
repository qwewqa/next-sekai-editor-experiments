const color = (name) => `rgb(var(--color-${name}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
module.exports = {
    // Touch screens must not keep hover styles after a tap.
    future: {
        hoverOnlyWhenSupported: true,
    },
    content: ['./index.html', './src/**/*.vue', './src/**/*.ts'],
    theme: {
        extend: {
            // Values per theme are in src/themes.css.
            colors: {
                fg: color('fg'),
                // Ink a step stronger than fg.
                'fg-strong': color('fg-strong'),
                bg: color('bg'),
                button: color('button'),
                accent: color('accent'),
                'on-accent': color('on-accent'),
                header: color('header'),
                // white/40 over header: hover on lavender bands, opaque so
                // sticky bands never show content scrolling beneath.
                'header-hover': color('header-hover'),
                modal: color('modal'),
                // Menus and select lists, and their row under the pointer or focus.
                popup: color('popup'),
                'popup-hover': color('popup-hover'),
                preview: color('preview'),
                // Destructive actions and errors (6.47:1 on white).
                danger: color('danger'),
                'on-danger': color('on-danger'),
                // The toggle switch's knob.
                knob: color('knob'),
            },
            boxShadow: {
                // The recessed track of a segmented control.
                track: 'var(--shadow-track)',
                // A sticky band raised over content scrolled beneath it: a
                // hairline and a soft shadow.
                band: 'var(--shadow-band)',
            },
            width: {
                screen: ['100vw', '100dvw'],
            },
            height: {
                screen: ['100vh', '100dvh'],
            },
        },
    },
}
