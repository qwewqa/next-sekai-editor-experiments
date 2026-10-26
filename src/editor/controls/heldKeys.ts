import { settings } from '../../settings'
import {
    blocksDefault,
    isApplePlatform,
    isBrowserChord,
    isCharacter,
    matchBindings,
} from './bindings'

// What an open menu, popover or select list keeps from the browser. A Ctrl/Cmd+R or F that no
// binding names goes to the browser, even while one is open.

const toBrowser = (event: KeyboardEvent) =>
    isBrowserChord(event) &&
    !matchBindings(settings.keyboardShortcuts, event, isApplePlatform()).exact

/** A Ctrl/Cmd+letter that an open menu, popover or list keeps from the browser, such as Ctrl+S saving the page. */
export const holdsChord = (event: KeyboardEvent) =>
    (event.ctrlKey || event.metaKey) && /^[a-z]$/i.test(event.key) && !toBrowser(event)

/** Whether an open menu keeps a typed character from the browser, as shortcuts do (Firefox quick find). */
export const holdsCharacter = (event: KeyboardEvent) =>
    isCharacter(event.key) && blocksDefault(event, false) && !toBrowser(event)
