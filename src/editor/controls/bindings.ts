/**
 * Shortcut bindings: a plain `event.key` (Shift folded into the key, as `U`), or a
 * chord `[Mod+][Alt+][Shift+]key`. Mod is Ctrl or Cmd on every platform.
 */

/** The parts of a key event that bindings read; a KeyboardEvent fits. */
export type KeyInput = {
    key: string
    ctrlKey: boolean
    metaKey: boolean
    altKey: boolean
    shiftKey: boolean
    getModifierState?: (key: string) => boolean
}

export type Chord = {
    mod: boolean
    alt: boolean
    shift: boolean
    key: string
}

export const isCharacter = (key: string) => key.length === 1 && key !== ' '

const isLetter = (key: string) => isCharacter(key) && key.toLowerCase() !== key.toUpperCase()

// A letter's case is Shift's alone, whatever Caps Lock or the platform report.
const plainKey = ({ key, shiftKey }: KeyInput) =>
    isLetter(key) ? (shiftKey ? key.toUpperCase() : key.toLowerCase()) : key

const prefixes = [
    ['mod', 'Mod+'],
    ['alt', 'Alt+'],
    ['shift', 'Shift+'],
] as const

export const parseChord = (binding: string): Chord | undefined => {
    const chord: Chord = { mod: false, alt: false, shift: false, key: binding }
    for (const [name, prefix] of prefixes) {
        if (!chord.key.startsWith(prefix) || chord.key.length === prefix.length) continue
        chord[name] = true
        chord.key = chord.key.slice(prefix.length)
    }
    return chord.key === binding ? undefined : chord
}

export const stringifyChord = ({ mod, alt, shift, key }: Chord) =>
    `${mod ? 'Mod+' : ''}${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${key}`

// Ctrl+Alt is AltGr on many layouts, which types characters such as [ and ].
const isAltGraph = (input: KeyInput) =>
    !!input.getModifierState?.('AltGraph') || (input.ctrlKey && input.altKey)

/**
 * Ctrl+Alt+letter or digit outside Apple platforms: read as AltGr, so it can be
 * neither recorded nor matched as a chord.
 */
export const isAltGraphAlphanumeric = (input: KeyInput, apple: boolean) =>
    !apple &&
    input.ctrlKey &&
    input.altKey &&
    !input.getModifierState?.('AltGraph') &&
    (isLetter(input.key) || /^[0-9]$/.test(input.key))

/** Ctrl or Cmd held as a command modifier, not as part of AltGr. */
export const isCommandChord = (input: KeyInput) =>
    (input.ctrlKey || input.metaKey) && !input.altKey && !input.getModifierState?.('AltGraph')

/** Ctrl/Cmd+R and Ctrl/Cmd+F, the browser's reload and find: only a binding of the chord itself takes them. */
export const isBrowserChord = (input: KeyInput) => {
    if (!isCommandChord(input)) return false
    const key = input.key.toLowerCase()
    return key === 'r' || (key === 'f' && !input.shiftKey)
}

/** The binding a key press records: letters lowercase with Shift spelled out. */
export const bindingOf = (input: KeyInput, apple: boolean) => {
    const { key } = input
    const character = isCharacter(key)
    if (character && isAltGraph(input)) return plainKey(input)
    const mod = input.ctrlKey || input.metaKey
    // Option types characters on Apple keyboards, as AltGr does elsewhere.
    const alt = input.altKey && !(apple && character)
    if (!mod && !alt && (character || !input.shiftKey)) return plainKey(input)
    const letter = isLetter(key)
    return stringifyChord({
        mod,
        alt,
        shift: input.shiftKey && (letter || !character),
        key: letter ? key.toLowerCase() : key,
    })
}

/** One spelling per binding, so equal chords compare equal. */
export const normalizeBinding = (binding: string) => {
    const chord = parseChord(binding)
    if (!chord) return binding
    return stringifyChord(
        isLetter(chord.key)
            ? { ...chord, key: chord.key.toLowerCase() }
            : { ...chord, shift: chord.shift && !isCharacter(chord.key) },
    )
}

/**
 * Names bound to a key press. A chord bound exactly wins; otherwise plain
 * bindings match the key whatever modifiers are held, except for the browser's chords.
 */
export const matchBindings = <N extends string>(
    shortcuts: Partial<Record<N, string>>,
    input: KeyInput,
    apple: boolean,
) => {
    const entries = Object.entries(shortcuts) as [N, string | undefined][]
    const binding = bindingOf(input, apple)
    if (parseChord(binding)) {
        const names = entries
            .filter(
                ([, value]) => value && parseChord(value) && normalizeBinding(value) === binding,
            )
            .map(([name]) => name)
        if (names.length) return { names, exact: true }
    }
    if (isBrowserChord(input)) return { names: [], exact: false }
    const key = plainKey(input)
    const names = entries
        .filter(([, value]) => value === key && !parseChord(value))
        .map(([name]) => name)
    return { names, exact: false }
}

/**
 * Whether a handled key keeps the browser's action out. With Ctrl or Cmd only
 * letters do (save, print, find...); zoom, tab switching and navigation stay.
 */
export const blocksDefault = (input: KeyInput, exact: boolean) => {
    if (input.ctrlKey || input.metaKey)
        return /^[a-z]$/i.test(input.key) && (exact || isCommandChord(input))
    return exact || !input.altKey
}

/** Chords the browser or OS keeps for itself, so pages never receive them. */
export const isReservedChord = (input: KeyInput, apple: boolean) => {
    const key = input.key.toLowerCase()
    if (apple) {
        if (!input.metaKey) return false
        if (input.altKey && key === 'escape') return true
        return !input.altKey && ['q', 'w', 't', 'n', 'h', 'm', ' ', '`', 'tab'].includes(key)
    }
    if (input.altKey && !input.ctrlKey && (key === 'f4' || key === 'tab')) return true
    if (!input.ctrlKey || input.metaKey || input.altKey) return false
    return ['n', 't', 'w', 'tab', 'escape'].includes(key)
}

/** Shown names for keys and modifiers, which locales may name their own way. */
export type KeyNames = Record<
    | 'space'
    | 'escape'
    | 'delete'
    | 'backspace'
    | 'enter'
    | 'tab'
    | 'pageUp'
    | 'pageDown'
    | 'home'
    | 'end'
    | 'insert'
    | 'ctrl'
    | 'alt'
    | 'shift',
    string
>

const englishKeyNames: KeyNames = {
    space: 'Space',
    escape: 'Esc',
    delete: 'Delete',
    backspace: 'Backspace',
    enter: 'Enter',
    tab: 'Tab',
    pageUp: 'Page Up',
    pageDown: 'Page Down',
    home: 'Home',
    end: 'End',
    insert: 'Insert',
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
}

let shownKeyNames = (): KeyNames => englishKeyNames

/** Sets where shown key names come from, such as the current locale. */
export const setKeyNames = (names: () => KeyNames) => {
    shownKeyNames = names
}

// Keys shown by another name; shown only, never stored.
const namedKeys = new Map<string, keyof KeyNames>([
    [' ', 'space'],
    ['Escape', 'escape'],
    ['Delete', 'delete'],
    ['Backspace', 'backspace'],
    ['Enter', 'enter'],
    ['Tab', 'tab'],
    ['PageUp', 'pageUp'],
    ['PageDown', 'pageDown'],
    ['Home', 'home'],
    ['End', 'end'],
    ['Insert', 'insert'],
])
const arrows = new Map([
    ['ArrowLeft', '←'],
    ['ArrowRight', '→'],
    ['ArrowUp', '↑'],
    ['ArrowDown', '↓'],
])
const keyName = (key: string, names: KeyNames) => {
    const named = namedKeys.get(key)
    return named ? names[named] : arrows.get(key)
}

/** Readable text for a binding; Apple platforms use the menu symbols. */
export const formatBinding = (binding: string | undefined, apple: boolean) => {
    if (!binding) return
    const names = shownKeyNames()
    const chord = parseChord(binding)
    if (!chord) {
        // Letters show as on the keycap; Shift is named, so a capital is never ambiguous.
        const named = keyName(binding, names)
        if (named) return named
        const upper = binding.toUpperCase()
        if (!isLetter(binding) || upper.length !== 1) return binding
        return binding === upper ? `${names.shift}+${binding}` : upper
    }
    const key =
        keyName(chord.key, names) ?? (isLetter(chord.key) ? chord.key.toUpperCase() : chord.key)
    if (apple)
        return `${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.mod ? '⌘' : ''}${key}`
    return [chord.mod && names.ctrl, chord.alt && names.alt, chord.shift && names.shift, key]
        .filter(Boolean)
        .join('+')
}

let appleDevice: boolean | undefined

/** Macs, iPads and iPhones, where Cmd plays Ctrl's part. */
export const isApplePlatform = () => {
    if (typeof navigator === 'undefined') return false
    // Read once. Every shortcut shown calls this, and Settings shows over a hundred.
    appleDevice ??= /mac|iphone|ipad|ipod/i.test(
        (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
            navigator.platform,
    )
    return appleDevice
}

/** A shown shortcut that is one punctuation mark, which needs more size and weight to read. */
export const isPunctuationShortcut = (shortcut: string) => /^[!-/:-@[-`{-~]$/.test(shortcut)

/** A binding as this device shows it. */
export const formatShortcut = (binding: string | undefined) =>
    formatBinding(binding, isApplePlatform())
