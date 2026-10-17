const color = (name) => `rgb(var(--color-${name}) / <alpha-value>)`

// Shared by the editor's and the landing pages' Tailwind configs. Values per theme are in src/themes.css.
const colors = {
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
}

const boxShadow = {
    // The recessed track of a segmented control.
    track: 'var(--shadow-track)',
    // A sticky band raised over content scrolled beneath it: a
    // hairline and a soft shadow.
    band: 'var(--shadow-band)',
}

module.exports = { colors, boxShadow }
