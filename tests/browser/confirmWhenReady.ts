import { expect, type Locator, type Page } from '@playwright/test'

// A Confirm or Choice dialog ignores activations in its first 300 ms. A press inside
// the guard is a no-op by design, so these helpers press again until the dialog is gone: they wait on
// what the dialog does, never on a fixed time. `dialog` must name that one dialog for good; with
// dialogs stacked, `.nth(i)` keeps pointing at the same one once it closes, where `.last()` would not.

const untilHidden = (press: () => Promise<void>, dialog: Locator) =>
    expect(async () => {
        await press()
        await expect(dialog).toBeHidden({ timeout: 300 })
    }).toPass({ timeout: 10_000 })

/** Clicks (or taps) `button` until `dialog` has closed. */
export const confirmWhenReady = (
    button: Locator,
    dialog: Locator,
    method: 'click' | 'tap' = 'click',
) => untilHidden(() => button[method](), dialog)

/** Presses `key` on `target` (a button, or a page for the focused element) until `dialog` has closed. */
export const confirmKeyWhenReady = (target: Locator | Page, key: string, dialog: Locator) =>
    untilHidden(
        () => ('keyboard' in target ? target.keyboard.press(key) : target.press(key)),
        dialog,
    )

/** New's question when the chart has edits no file holds. */
export const newDialog = (page: Page) => page.getByRole('dialog', { name: 'Start a New Chart?' })

/** Answers New's question with New Chart. */
export const confirmNew = (page: Page) => {
    const dialog = newDialog(page)
    return confirmWhenReady(dialog.getByRole('button', { name: 'New Chart' }), dialog)
}
