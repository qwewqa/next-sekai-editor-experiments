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
                // Dims what lies behind dialogs and open toolbar flyouts.
                scrim: color('scrim'),
                button: color('button'),
                accent: color('accent'),
                'on-accent': color('on-accent'),
                // Tints rows selected for an action, and the folder a drag would join.
                selected: color('selected'),
                header: color('header'),
                // Hover on header bands, opaque so sticky bands never show content
                // scrolling beneath.
                'header-hover': color('header-hover'),
                // Hover on buttons on a band, lighter than the band's own hover. Carries its
                // own alpha, so no opacity modifier.
                'band-hover': 'var(--color-band-hover)',
                modal: color('modal'),
                // Menus and select lists, and their row under the pointer or focus.
                popup: color('popup'),
                'popup-hover': color('popup-hover'),
                // Their outline; carries its own alpha.
                'popup-edge': 'var(--color-popup-edge)',
                preview: color('preview'),
                // Destructive actions and errors.
                danger: color('danger'),
                'on-danger': color('on-danger'),
                // White handles: toggle knobs, slider thumbs and resize grabbers.
                knob: color('knob'),
                // Recessed tracks of segmented controls and sliders; carries its own alpha.
                recess: 'var(--color-recess)',
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
