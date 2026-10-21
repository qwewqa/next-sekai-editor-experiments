import { expect, test, type Page } from '@playwright/test'
import { installEditorFixture } from './editorFixture'

// A key pressed just after Escape closes a dialog reaches the editor. The native dialog fires its
// `close` event a task after it closes, and a busy page runs queued input first; the dialog leaves
// the modal stack as Escape closes it, so the key is never dropped. Each burst below holds the
// first key's keydown long enough that the keys after it are queued before that `close` task, as
// on a busy page, so the order is the same on every run.

const boot = async (page: Page) => {
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

const lifeOf = (page: Page) =>
    page.evaluate(() => window.editorTest.history.liveState.value.initialLife)

/** One Initial Life step, so Undo has something to undo. */
const pushStep = (page: Page) =>
    page.evaluate(() => {
        const { history, historySteps } = window.editorTest
        const before = history.liveState.value.initialLife
        history.pushState(historySteps.initialLife(before, before + 1), {
            ...history.liveState.value,
            initialLife: before + 1,
        })
    })

/** Opens an information dialog named `name`; `window.dialogsClosed` counts how often each one resolved. */
const openInfo = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const { showModal } =
            await window.editorTest.appImport<typeof import('../../src/modals/index')>(
                '/src/modals/index.ts',
            )
        const { default: InfoModal } = await window.editorTest.appImport<
            typeof import('../../src/modals/InfoModal.vue')
        >('/src/modals/InfoModal.vue')
        const closed = (Reflect.get(window, 'dialogsClosed') ?? {}) as Record<string, number>
        Reflect.set(window, 'dialogsClosed', closed)
        closed[name] = 0
        void showModal(InfoModal, { title: () => name, message: () => 'Message' }).then(() => {
            closed[name] = (closed[name] ?? 0) + 1
        })
    }, name)

const closedCounts = (page: Page) =>
    page.evaluate(() => (Reflect.get(window, 'dialogsClosed') ?? {}) as Record<string, number>)

const modalCount = async (page: Page) => {
    const { modals } = await page.evaluate(() =>
        window.editorTest
            .appImport<typeof import('../../src/modals/index')>('/src/modals/index.ts')
            .then(({ modals }) => ({ modals: modals.length })),
    )
    return modals
}

/** Lets the native `close` events and any later tasks run. */
const settle = (page: Page) =>
    page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => setTimeout(() => setTimeout(resolve, 20), 0)),
            ),
    )

const KEYS = {
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    z: { key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, text: 'z' },
}

/**
 * Presses `keys` with no wait between them. The first key's keydown holds the page's main thread
 * for a moment, so every key after it is queued before the tasks its default action queues.
 */
const burst = async (page: Page, keys: (keyof typeof KEYS)[]) => {
    await page.evaluate((first) => {
        const hold = (event: KeyboardEvent) => {
            if (event.key !== first) return
            removeEventListener('keydown', hold, true)
            const end = performance.now() + 400
            while (performance.now() < end);
        }
        addEventListener('keydown', hold, true)
    }, KEYS[keys[0]!].key)
    const cdp = await page.context().newCDPSession(page)
    const sent: Promise<unknown>[] = []
    for (const name of keys) {
        const { text, ...key } = KEYS[name] as (typeof KEYS)[keyof typeof KEYS] & { text?: string }
        sent.push(
            cdp.send('Input.dispatchKeyEvent', {
                type: text ? 'keyDown' : 'rawKeyDown',
                ...key,
                ...(text ? { text, unmodifiedText: text } : {}),
            }),
            cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }),
        )
    }
    await Promise.all(sent)
    await cdp.detach()
}

/** User activation, so the page may keep a dialog open on Escape (close watchers). */
const activate = async (page: Page, name: string) => {
    await page.getByRole('dialog', { name }).getByText('Message').click()
}

test('a key pressed just after Escape closes a dialog acts', async ({ page }) => {
    await boot(page)
    await pushStep(page)
    const start = await lifeOf(page)
    await openInfo(page, 'First')
    await expect(page.getByRole('dialog', { name: 'First' })).toBeVisible()

    await burst(page, ['Escape', 'z'])
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => lifeOf(page)).toBe(start - 1)

    // The close event that follows finds the dialog gone: it resolves once.
    await settle(page)
    expect(await closedCounts(page)).toEqual({ First: 1 })
    expect(await modalCount(page)).toBe(0)
    expect(await lifeOf(page)).toBe(start - 1)
})

test('a key pressed just after a button closes a dialog acts', async ({ page }) => {
    await boot(page)
    await pushStep(page)
    const start = await lifeOf(page)
    await openInfo(page, 'First')
    const ok = page.getByRole('dialog', { name: 'First' }).getByRole('button', { name: 'OK' })
    await ok.focus()

    await burst(page, ['Enter', 'z'])
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => lifeOf(page)).toBe(start - 1)
    await settle(page)
    expect(await closedCounts(page)).toEqual({ First: 1 })
})

test('Escape closes only the top dialog, and the editor takes no key while the one under it is open', async ({
    page,
}) => {
    await boot(page)
    await pushStep(page)
    const start = await lifeOf(page)
    await openInfo(page, 'Outer')
    await expect(page.getByRole('dialog', { name: 'Outer' })).toBeVisible()
    await openInfo(page, 'Inner')
    await expect(page.getByRole('dialog', { name: 'Inner' })).toBeVisible()
    await activate(page, 'Inner')

    await burst(page, ['Escape', 'z'])
    await expect(page.getByRole('dialog', { name: 'Inner' })).toHaveCount(0)
    await settle(page)
    await expect(page.getByRole('dialog', { name: 'Outer' })).toBeVisible()
    expect(await closedCounts(page)).toEqual({ Outer: 0, Inner: 1 })
    expect(await modalCount(page)).toBe(1)
    expect(await lifeOf(page)).toBe(start)

    await activate(page, 'Outer')
    await burst(page, ['Escape', 'z'])
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => lifeOf(page)).toBe(start - 1)
    await settle(page)
    expect(await closedCounts(page)).toEqual({ Outer: 1, Inner: 1 })
})

test('a busy dialog keeps Escape for its task, and the editor takes no key meanwhile', async ({
    page,
}) => {
    await boot(page)
    await pushStep(page)
    const start = await lifeOf(page)
    await openInfo(page, 'Busy')
    const dialog = page.getByRole('dialog', { name: 'Busy' })
    await expect(dialog).toBeVisible()
    // Its message is the busy content: Escape ends the task first.
    await page.evaluate(() => {
        const message = [...document.querySelectorAll('dialog div')].find(
            (element) => element.textContent === 'Message',
        )!
        message.setAttribute('data-modal-busy', '')
        Reflect.set(window, 'busyCancels', 0)
        message.addEventListener('modalcancel', () => {
            Reflect.set(window, 'busyCancels', (Reflect.get(window, 'busyCancels') as number) + 1)
            message.removeAttribute('data-modal-busy')
        })
    })
    await activate(page, 'Busy')

    await burst(page, ['Escape', 'z'])
    await settle(page)
    await expect(dialog).toBeVisible()
    expect(await page.evaluate(() => Reflect.get(window, 'busyCancels'))).toBe(1)
    expect(await closedCounts(page)).toEqual({ Busy: 0 })
    expect(await modalCount(page)).toBe(1)
    expect(await lifeOf(page)).toBe(start)

    // With the task ended, Escape closes it.
    await burst(page, ['Escape', 'z'])
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => lifeOf(page)).toBe(start - 1)
    await settle(page)
    expect(await closedCounts(page)).toEqual({ Busy: 1 })
})

test('Escape returns focus to the opener once, before the next key', async ({ page }) => {
    await boot(page)
    await pushStep(page)
    const start = await lifeOf(page)
    await page.evaluate(() => {
        const opener = document.createElement('button')
        opener.textContent = 'Opener'
        opener.id = 'opener'
        Reflect.set(window, 'openerFocus', [])
        opener.addEventListener('focus', () =>
            (Reflect.get(window, 'openerFocus') as boolean[]).push(
                !!document.querySelector('dialog[open]'),
            ),
        )
        document.body.append(opener)
    })
    await page.locator('#opener').focus()
    await page.evaluate(() => Reflect.set(window, 'openerFocus', []))
    await openInfo(page, 'First')
    await expect(page.getByRole('dialog', { name: 'First' })).toBeVisible()

    // The key that follows Escape lands with the opener focused.
    await page.evaluate(() => {
        Reflect.set(window, 'zTarget', null)
        addEventListener(
            'keydown',
            (event) => {
                if (event.key === 'z') Reflect.set(window, 'zTarget', document.activeElement?.id)
            },
            true,
        )
    })
    await burst(page, ['Escape', 'z'])
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => lifeOf(page)).toBe(start - 1)
    await settle(page)
    expect(await page.evaluate(() => Reflect.get(window, 'openerFocus'))).toEqual([false])
    expect(await page.evaluate(() => Reflect.get(window, 'zTarget'))).toBe('opener')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('opener')
    expect(await closedCounts(page)).toEqual({ First: 1 })
})
