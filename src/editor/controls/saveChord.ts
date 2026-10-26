import { isCommandChord } from './bindings'

/** Ctrl+S, or Cmd+S on Apple keyboards: Save's fixed alias, outside the customizable map. */
export const isSaveChord = (event: KeyboardEvent) =>
    isCommandChord(event) && !event.shiftKey && event.key.toLowerCase() === 's'

// Events whose only cancel is the one below.
const cancelledByUs = new WeakSet<Event>()

/** Keeps Save Page from opening, and marks the cancel as not the key being taken. */
export const cancelSavePage = (event: KeyboardEvent) => {
    if (!isSaveChord(event) || event.defaultPrevented) return
    cancelledByUs.add(event)
    event.preventDefault()
}

/** Whether something took the key: `defaultPrevented`, unless only Save Page was cancelled. */
export const isConsumed = (event: Event) => event.defaultPrevented && !cancelledByUs.has(event)
