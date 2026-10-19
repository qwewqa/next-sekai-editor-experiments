const color = (name) => `rgb(var(--color-${name}) / <alpha-value>)`

// Shared by the editor's and the landing pages' Tailwind configs. Values per theme are in
// src/themes.css; what each role means is in docs/color-system.md. Buttons take their colours
// from the recipes in src/controls.css, not from these classes directly.
const colors = {
    fg: color('fg'),
    // Ink a step stronger than fg; also the ink of a pressed control.
    'fg-strong': color('fg-strong'),
    bg: color('bg'),
    // Dims what lies behind dialogs and open toolbar flyouts.
    scrim: color('scrim'),
    button: color('button'),
    // Mint: something is on. Its pressed step, and a deeper mint for thin marks on light surfaces.
    accent: color('accent'),
    'on-accent': color('on-accent'),
    'accent-press': color('accent-press'),
    'accent-strong': color('accent-strong'),
    // Tints rows checked for an action, and the folder a drag would join.
    selected: color('selected'),
    // The primary action: ink in light, periwinkle in dark.
    primary: color('primary'),
    'on-primary': color('on-primary'),
    'primary-press': color('primary-press'),
    // A raised face while pressed.
    press: color('press'),
    header: color('header'),
    // Hover on header bands, opaque so sticky bands never show content
    // scrolling beneath.
    'header-hover': color('header-hover'),
    // Hover and press on buttons on a band, lighter than the band's own hover.
    // Carry their own alpha, so no opacity modifier.
    'band-hover': 'var(--color-band-hover)',
    'band-press': 'var(--color-band-press)',
    // Press on a ghost over a panel or popup, and on the dark chrome; carry their own alpha.
    'ghost-press': 'var(--color-ghost-press)',
    'chrome-press': 'var(--color-chrome-press)',
    modal: color('modal'),
    // Menus and select lists, and their row under the pointer or focus.
    popup: color('popup'),
    'popup-hover': color('popup-hover'),
    // Their outline; carries its own alpha.
    'popup-edge': 'var(--color-popup-edge)',
    preview: color('preview'),
    // Destructive actions and errors: text, the filled button and its press.
    danger: color('danger'),
    'danger-fill': color('danger-fill'),
    'on-danger': color('on-danger'),
    'danger-press': color('danger-press'),
    // Status text and glyphs, always with their glyph.
    warning: color('warning'),
    info: color('info'),
    // A History entry's changes, the same in every theme.
    change: color('change'),
    // White handles: toggle knobs, slider thumbs and resize grabbers.
    knob: color('knob'),
    // The track of a switch that is off.
    'toggle-off': color('toggle-off'),
    // Recessed tracks of segmented controls and sliders; carries its own alpha.
    recess: 'var(--color-recess)',
}

const boxShadow = {
    // The recessed track of a segmented control.
    track: 'var(--shadow-track)',
    // A raised control while pressed: it sinks.
    pressed: 'var(--shadow-pressed)',
    // A sticky band raised over content scrolled beneath it: a
    // hairline and a soft shadow.
    band: 'var(--shadow-band)',
}

module.exports = { colors, boxShadow }
