import { onMounted, onUnmounted, watch } from 'vue'
import { selectedEntities } from '../../history/selectedEntities'
import { isBlockingModalOpen, isToolDialogOpen } from '../../modals'
import { holdsTyping } from '../../modals/form/resync'
import { settings } from '../../settings'
import { isComposingKey } from '../../utils/composition'
import { commands, isCommandName, type CommandName } from '../commands'
import { runCommand } from '../commands/runCommand'
import { drawerSide, takesDockKeys } from '../workspace'
import {
    blocksDefault,
    isApplePlatform,
    isCharacter,
    isCommandChord,
    matchBindings,
} from './bindings'
import { isDragging } from './gestures/recognizers/drag'
import { hasMouseControls } from './mouse'
import { clearPageSelection } from './pageSelection'

export const isTextEntry = (target: EventTarget | null) =>
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement &&
        !['button', 'checkbox', 'radio', 'range', 'color', 'file'].includes(target.type)) ||
    (target instanceof HTMLElement && target.isContentEditable)

// Space and Enter press a focused button, and Space a checkbox or radio, and nothing else.
const pressesButton = ({ target, key }: KeyboardEvent) => {
    if (
        target instanceof HTMLButtonElement ||
        (target instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(target.type))
    )
        return key === ' ' || key === 'Enter'
    return (
        target instanceof HTMLInputElement &&
        ['checkbox', 'radio'].includes(target.type) &&
        key === ' '
    )
}

// Fields keep every key.
const keepsDefault = (event: KeyboardEvent) => {
    const { target } = event
    return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
    )
}

// Alt+N, or Option+N on macOS, by code.
const isNoticeChord = (event: KeyboardEvent) =>
    event.code === 'KeyN' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey

const isApple = isApplePlatform()

const isInToolDialog = (element: Element | null) => !!element?.closest('[data-tool-dialog]')

// Radios and chip rows move with arrow keys.
const movesFocus = (element: Element, key: string) =>
    /^(Arrow|Home$|End$)/.test(key) && element.matches('input[type="radio"], [role="toolbar"] *')

// Only the commands Help lists repeat when held; the rest act once per press.
export const repeatsWhenHeld = new Set<CommandName>([
    'scrollLeft',
    'scrollRight',
    'scrollUp',
    'scrollDown',
    'scrollPageUp',
    'scrollPageDown',
    'zoomXIn',
    'zoomXOut',
    'zoomYIn',
    'zoomYOut',
    'undo',
    'redo',
    'increaseNoteSize',
    'decreaseNoteSize',
    'speedUp',
    'speedDown',
    'groupPrev',
    'groupNext',
    'stagePrev',
    'stageNext',
])

// Playback and jumps would move the view under a press; only edge scroll moves it then.
const movesViewUnderPress = new Set<CommandName>(['play', 'stop', 'jumpUp', 'jumpDown'])

// Only controls with no local Escape action return it to chart selection. Keep
// typing, manager rows, preview controls and elevation navigation in their owners.
const returnsDeselect = (element: Element | null) => {
    if (element?.closest('.properties-panel')) {
        if (element instanceof HTMLSelectElement)
            return CSS.supports('selector(:open)') && !element.matches(':open')
        return (
            element instanceof HTMLButtonElement ||
            (element instanceof HTMLInputElement &&
                ['button', 'checkbox', 'radio'].includes(element.type))
        )
    }
    return (
        element instanceof HTMLButtonElement &&
        element.matches('.panel-rail [data-panel-tab], .panel-rail .panel-rail-toggle')
    )
}

/** Ctrl+S, or Cmd+S on Apple keyboards: Save's fixed alias, outside the customizable map. */
export const isSaveChord = (event: KeyboardEvent) =>
    isCommandChord(event) && !event.shiftKey && event.key.toLowerCase() === 's'

/** Runs before any component can stop the key, so Save Page never opens. */
const cancelSavePage = (event: KeyboardEvent) => {
    if (isSaveChord(event)) event.preventDefault()
}

const onKeydown = (event: KeyboardEvent) => {
    // A modal takes no commands.
    if (isBlockingModalOpen.value) return
    if (pressesButton(event)) return
    // An open tool dialog takes Escape.
    if (isToolDialogOpen.value && event.key === 'Escape') return

    const commandChord = isCommandChord(event) && isCharacter(event.key)
    const active = document.activeElement
    // Bindings naming commands not registered yet wait for them, and never mask others.
    const matched = matchBindings(
        Object.fromEntries(
            Object.entries(settings.keyboardShortcuts).filter(([name]) => isCommandName(name)),
        ),
        event,
        isApple,
    )
    // Ctrl/Cmd+S is Save's fixed alias, unless a binding takes that chord itself.
    const alias = !matched.exact && isSaveChord(event)
    const names: CommandName[] = alias ? ['save'] : matched.names.filter(isCommandName)
    const exact = alias || matched.exact
    // Alt+N belongs to the notice card, even where that does not act; never plain n.
    if (!exact && isNoticeChord(event)) return
    // Bubble-phase only: field/menu/drawer/drag handlers keep first refusal. This
    // exception enables just the bound Deselect action, never other Escape bindings.
    if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !event.repeat &&
        !isComposingKey(event) &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        !drawerSide.value &&
        event.target === active &&
        takesDockKeys(active) &&
        returnsDeselect(active) &&
        names.includes('deselect')
    ) {
        event.preventDefault()
        void runCommand(commands.deselect, 'key')
        return
    }
    // A field showing its committed value passes undo, redo and save to the editor.
    const passesToEditor =
        commandChord &&
        isTextEntry(active) &&
        names.some((name) => name === 'undo' || name === 'redo' || name === 'save') &&
        !holdsTyping(active)
    // In docks, fields keep their keys; other controls pass only unclaimed Ctrl or Cmd chords.
    // Tool dialogs float over the chart, so only their fields and selects hold keys that way.
    const inDialog = isInToolDialog(active)
    if (
        takesDockKeys(active) ||
        (inDialog && (isTextEntry(active) || active instanceof HTMLSelectElement))
    ) {
        // The capture-phase cancel of Save Page marks a Save chord prevented; that does not count.
        if (
            !commandChord ||
            (event.defaultPrevented && !isSaveChord(event)) ||
            (isTextEntry(active) && !passesToEditor)
        ) {
            return
        }
    }
    if (inDialog && active && movesFocus(active, event.key)) return

    // Selected page text keeps its native copy and cut, and the objects stay as they are.
    if (
        isCommandChord(event) &&
        names.some((name) => name === 'copy' || name === 'cut') &&
        String(getSelection() ?? '').trim() !== ''
    )
        return
    const pressing = isDragging.value > 0 || hasMouseControls()
    for (const name of names) {
        if (event.repeat && !repeatsWhenHeld.has(name)) continue
        if (pressing && movesViewUnderPress.has(name)) continue
        void runCommand(commands[name], event.repeat ? 'repeat' : 'key')
    }
    if (!names.length) return
    // A command chord has no native use outside text entry, so selects and toggles drop it.
    if (
        keepsDefault(event) &&
        !isSaveChord(event) &&
        !(isCommandChord(event) && (passesToEditor || !isTextEntry(event.target)))
    )
        return

    // Handled keys skip browser defaults such as Firefox quick find, WebKit Backspace
    // navigation and Ctrl+S saving the page; zoom and tab keys keep theirs.
    if (blocksDefault(event, exact)) event.preventDefault()
}

export const useKeyboardControl = () => {
    // A new object selection drops page text selected before it, so Ctrl+C copies the objects.
    watch(
        selectedEntities,
        () => {
            if (!isTextEntry(document.activeElement)) clearPageSelection()
        },
        { flush: 'sync' },
    )

    onMounted(() => {
        addEventListener('keydown', cancelSavePage, true)
        addEventListener('keydown', onKeydown)
    })

    onUnmounted(() => {
        removeEventListener('keydown', cancelSavePage, true)
        removeEventListener('keydown', onKeydown)
    })
}
