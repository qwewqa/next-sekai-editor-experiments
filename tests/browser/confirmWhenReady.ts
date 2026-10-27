import { expect, type ElementHandle, type Locator, type Page } from '@playwright/test'

// A Confirm or Choice dialog ignores activations in its first 300 ms. A press inside
// the guard is a no-op by design, so these helpers press again until the dialog is gone: they wait on
// what the dialog does, never on a fixed time. `dialog` names the dialog that holds the button. It
// is resolved to its element once, so a later dialog with the same title (the loading dialog that
// a deletion shows, say) is not taken for it.
//
// They end when the press is accepted, which is when that dialog closes. What the press starts,
// such as a deletion or a reload, can take longer than that; the caller waits for it next, with
// `workTimeout`.

/** How long to wait for what an accepted press started, such as a reload or a deletion, on a CI runner. */
export const workTimeout = process.env.CI ? 40_000 : 10_000

const untilAccepted = async (press: () => Promise<void>, dialog: Locator) => {
    let own: ElementHandle | null = null
    await expect(async () => {
        // The first pass may find a dialog that is still arriving, or two; the next one finds one.
        own ??= await dialog.elementHandle({ timeout: 1_000 })
        // A press that was accepted but not yet seen to close the dialog must not be pressed again.
        if (!(await own.isVisible())) return
        await press()
        await own.waitForElementState('hidden', { timeout: 300 })
    }).toPass({ timeout: process.env.CI ? 20_000 : 10_000 })
}

// A press has no more than this to find its button, which an accepted press may have removed.
const PRESS = { timeout: 2_000 }

/** Clicks (or taps) `button` until `dialog` has closed. */
export const confirmWhenReady = (
    button: Locator,
    dialog: Locator,
    method: 'click' | 'tap' = 'click',
) => untilAccepted(() => button[method](PRESS), dialog)

/** Presses `key` on `target` (a button, or a page for the focused element) until `dialog` has closed. */
export const confirmKeyWhenReady = (target: Locator | Page, key: string, dialog: Locator) =>
    untilAccepted(
        () => ('keyboard' in target ? target.keyboard.press(key) : target.press(key, PRESS)),
        dialog,
    )

/** Answers New's "Unsaved Changes" question with New. */
export const confirmNew = (page: Page) => {
    const dialog = page.getByRole('dialog', { name: 'Unsaved Changes' })
    return confirmWhenReady(dialog.getByRole('button', { name: 'New' }), dialog)
}
