import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// The shared choice dialog: order, default focus, guards, stacking, danger styling.

const boot = async (page: Page) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

type Shape = 'replace' | 'destructive' | 'described' | 'long'

/** Opens a dialog and keeps its answer in `window.answers`. */
const open = (page: Page, shape: Shape, title = 'Changed on Disk') =>
    page.evaluate(
        async ({ shape, title }) => {
            const { showChoice } =
                await window.editorTest.appImport<typeof import('../../src/modals/choice')>(
                    '/src/modals/choice.ts',
                )
            const answers = (Reflect.get(window, 'answers') ?? []) as unknown[]
            Reflect.set(window, 'answers', answers)
            const record = (answer: unknown) => answers.push(`${title}:${String(answer)}`)
            const options =
                shape === 'replace'
                    ? {
                          title: () => title,
                          message: () => 'The file changed.',
                          choices: [
                              { value: 'replace', label: () => 'Replace', danger: true },
                              {
                                  value: 'separate',
                                  label: () => 'Save as a Separate File',
                                  default: true,
                              },
                          ],
                      }
                    : shape === 'destructive'
                      ? {
                            title: () => title,
                            choices: [{ value: 'delete', label: () => 'Delete', danger: true }],
                            cancelIsDefault: true,
                        }
                      : shape === 'described'
                        ? {
                              title: () => title,
                              choices: [
                                  {
                                      value: 'replace',
                                      label: () => 'Replace',
                                      danger: true,
                                      description: () => 'The file on disk is overwritten.',
                                  },
                                  {
                                      value: 'separate',
                                      label: () => 'Save as a Separate File',
                                      default: true,
                                  },
                              ],
                          }
                        : {
                              title: () => title,
                              choices: [
                                  {
                                      value: 'a',
                                      label: () => 'Enregistrer sous un autre nom de fichier',
                                  },
                                  {
                                      value: 'b',
                                      label: () => 'Remplacer le fichier existant sur le disque',
                                      default: true,
                                  },
                              ],
                          }
            void showChoice(options).then(record)
        },
        { shape, title },
    )

const dialog = (page: Page) => page.getByRole('dialog').last()
const names = (page: Page) =>
    dialog(page)
        .getByRole('button')
        .evaluateAll((buttons) =>
            buttons
                .filter((button) => !button.hasAttribute('aria-label'))
                .map((button) => button.textContent.trim()),
        )
const answers = (page: Page) => page.evaluate(() => Reflect.get(window, 'answers') as string[])

// Past the 300 ms guard.
const settle = (page: Page) => page.waitForTimeout(400)

test('buttons run Cancel, the other choices, then the safe default on the right, which has focus', async ({
    page,
}) => {
    await boot(page)
    await open(page, 'replace')
    await expect(dialog(page)).toBeVisible()
    expect(await names(page)).toEqual(['Cancel', 'Replace', 'Save as a Separate File'])
    await expect(
        dialog(page).getByRole('button', { name: 'Save as a Separate File' }),
    ).toBeFocused()
    // The danger choice is danger-styled and is not the rightmost.
    const boxes = await dialog(page)
        .getByRole('button')
        .evaluateAll((buttons) =>
            buttons
                .filter((button) => !button.hasAttribute('aria-label'))
                .map((button) => ({
                    text: button.textContent.trim(),
                    x: button.getBoundingClientRect().x,
                    background: getComputedStyle(button).backgroundColor,
                    color: getComputedStyle(button).color,
                })),
        )
    expect(boxes.map((box) => box.text)).toEqual(['Cancel', 'Replace', 'Save as a Separate File'])
    expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x)
    expect(boxes[1]!.x).toBeLessThan(boxes[2]!.x)
    // Only the safe default is filled (primary). The danger choice is quiet: a neutral face like
    // Cancel's, told apart by its red label.
    expect(boxes[1]!.background).toBe(boxes[0]!.background)
    expect(boxes[2]!.background).not.toBe(boxes[0]!.background)
    expect(boxes[1]!.color).not.toBe(boxes[0]!.color)
    expect(boxes[2]!.color).not.toBe(boxes[0]!.color)
    await settle(page)
    await dialog(page).getByRole('button', { name: 'Replace' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await answers(page)).toEqual(['Changed on Disk:replace'])
})

test('when Cancel is the safe default it is rightmost and focused, with the danger button to its left', async ({
    page,
}) => {
    await boot(page)
    await open(page, 'destructive')
    expect(await names(page)).toEqual(['Delete', 'Cancel'])
    await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused()
    await settle(page)
    await dialog(page).getByRole('button', { name: 'Cancel' }).click()
    expect(await answers(page)).toEqual(['Changed on Disk:undefined'])
})

test('Escape, × and an outside press all cancel', async ({ page }) => {
    await boot(page)
    await open(page, 'replace', 'One')
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await open(page, 'replace', 'Two')
    await settle(page)
    await dialog(page).getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await open(page, 'replace', 'Three')
    await settle(page)
    await page.mouse.click(2, 2)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await answers(page)).toEqual(['One:undefined', 'Two:undefined', 'Three:undefined'])
})

test('a press within 300 ms of opening is ignored, and one after it works', async ({ page }) => {
    // The clock is stopped once the page is up, so no real time passes between opening and pressing.
    await page.clock.install()
    await boot(page)
    await page.clock.pauseAt(new Date(Date.now() + 60_000))
    await page.evaluate(async () => {
        const { showChoice } =
            await window.editorTest.appImport<typeof import('../../src/modals/choice')>(
                '/src/modals/choice.ts',
            )
        Reflect.set(window, 'answers', [])
        void showChoice({
            title: () => 'Guard',
            choices: [{ value: 'go', label: () => 'Go', default: true }],
        }).then((answer) => (Reflect.get(window, 'answers') as unknown[]).push(String(answer)))
        // The dialog is in the page. Then press, as a held Enter that opened it would.
        await window.editorTest.nextTick()
        document.querySelector<HTMLElement>('dialog button[data-choice="default"]')?.click()
    })
    await expect(dialog(page)).toBeVisible()
    expect(await answers(page)).toEqual([])
    await page.clock.runFor(299)
    await dialog(page).getByRole('button', { name: 'Go' }).click()
    expect(await answers(page)).toEqual([])
    await page.clock.runFor(2)
    await dialog(page).getByRole('button', { name: 'Go' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await answers(page)).toEqual(['go'])
})

test('a dialog never has the close button focused, even for the first frame', async ({ page }) => {
    await boot(page)
    const first = await page.evaluate(async () => {
        const { showChoice } =
            await window.editorTest.appImport<typeof import('../../src/modals/choice')>(
                '/src/modals/choice.ts',
            )
        void showChoice({
            title: () => 'First Frame',
            choices: [{ value: 'go', label: () => 'Go', default: true }],
        })
        await window.editorTest.nextTick()
        // After the dialog is shown, before the timer that focuses its default.
        const active = document.activeElement
        return active instanceof HTMLButtonElement
            ? (active.getAttribute('aria-label') ?? active.textContent)
            : active?.tagName
    })
    expect(first).not.toMatch(/close/i)
    await expect(dialog(page).getByRole('button', { name: 'Go' })).toBeFocused()
})

test('a held Enter does not confirm: repeats are ignored', async ({ page }) => {
    await boot(page)
    // Enter goes down before the dialog opens, as the press that opened it would.
    await page.keyboard.down('Enter')
    await open(page, 'replace')
    await expect(dialog(page)).toBeVisible()
    await settle(page)
    const separate = dialog(page).getByRole('button', { name: 'Save as a Separate File' })
    await expect(separate).toBeFocused()
    // The key is still down, so these are real repeating keydowns on the focused default.
    await page.keyboard.down('Enter')
    await page.keyboard.down('Enter')
    await page.keyboard.up('Enter')
    await expect(dialog(page)).toBeVisible()
    expect(await answers(page)).toEqual([])
    // A fresh press does confirm.
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await answers(page)).toEqual(['Changed on Disk:separate'])
})

test('a choice with a description shows it under its button, and the default is on top', async ({
    page,
}) => {
    await boot(page)
    await open(page, 'described')
    await expect(dialog(page)).toBeVisible()
    const replace = dialog(page).getByRole('button', { name: 'Replace' })
    await expect(replace).toHaveAccessibleDescription('The file on disk is overwritten.')
    const text = dialog(page).getByText('The file on disk is overwritten.')
    const [button, note] = [(await replace.boundingBox())!, (await text.boundingBox())!]
    expect(note.y).toBeGreaterThanOrEqual(button.y + button.height)
    // Stacked: the safe default first, Cancel last.
    expect(await names(page)).toEqual(['Save as a Separate File', 'Replace', 'Cancel'])
    await expect(
        dialog(page).getByRole('button', { name: 'Save as a Separate File' }),
    ).toBeFocused()
    await settle(page)
    await expect(
        dialog(page).getByRole('button', { name: 'Save as a Separate File' }),
    ).toBeFocused()
})

test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('buttons stack with the safe default on top and Cancel last, at 36 px', async ({
        page,
    }) => {
        await boot(page)
        await open(page, 'replace')
        await expect(dialog(page)).toBeVisible()
        expect(await names(page)).toEqual(['Save as a Separate File', 'Replace', 'Cancel'])
        const boxes = await dialog(page)
            .getByRole('button')
            .evaluateAll((buttons) =>
                buttons
                    .filter((button) => !button.hasAttribute('aria-label'))
                    .map((button) => button.getBoundingClientRect()),
            )
        expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y)
        expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y)
        for (const box of boxes) expect(box.height).toBe(36)
        const close = dialog(page).getByRole('button', { name: 'Close', exact: true })
        expect((await close.boundingBox())!.width).toBe(36)
        expect((await close.locator('..').boundingBox())!.height).toBe(48)
        // The declared default keeps focus in the new order, before and after the guard.
        const separate = dialog(page).getByRole('button', { name: 'Save as a Separate File' })
        await expect(separate).toBeFocused()
        await settle(page)
        await expect(separate).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        expect(await answers(page)).toEqual(['Changed on Disk:separate'])
    })
})

test('long labels stack the buttons on a wide screen too', async ({ page }) => {
    await boot(page)
    await page.setViewportSize({ width: 700, height: 800 })
    await open(page, 'long')
    await expect(dialog(page)).toBeVisible()
    expect(await names(page)).toEqual([
        'Remplacer le fichier existant sur le disque',
        'Enregistrer sous un autre nom de fichier',
        'Cancel',
    ])
    const safe = dialog(page).getByRole('button', {
        name: 'Remplacer le fichier existant sur le disque',
    })
    await expect(safe).toBeFocused()
    await settle(page)
    await expect(safe).toBeFocused()
    // Narrowing the window restacks nothing new, and focus stays on the default.
    await page.setViewportSize({ width: 390, height: 800 })
    await expect(safe).toBeFocused()
})

test('dialogs stack: the later one answers first, and Escape closes only the top', async ({
    page,
}) => {
    await boot(page)
    await open(page, 'replace', 'First')
    await expect(dialog(page)).toBeVisible()
    await open(page, 'replace', 'Second')
    await expect(page.getByRole('dialog')).toHaveCount(2)
    await expect(page.getByRole('dialog', { name: 'Second' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.getByRole('dialog', { name: 'First' })).toBeVisible()
    await settle(page)
    await page
        .getByRole('dialog', { name: 'First' })
        .getByRole('button', { name: 'Replace' })
        .click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await answers(page)).toEqual(['Second:undefined', 'First:replace'])
})

test('a dialog without exactly one safe default is refused', async ({ page }) => {
    await boot(page)
    const errors = await page.evaluate(async () => {
        const { arrangeChoices } =
            await window.editorTest.appImport<typeof import('../../src/modals/choice')>(
                '/src/modals/choice.ts',
            )
        const attempt = (run: () => unknown) => {
            try {
                run()
                return 'accepted'
            } catch (error) {
                return String(error)
            }
        }
        const label = () => 'x'
        return [
            attempt(() => arrangeChoices({ title: label, choices: [{ value: 1, label }] })),
            attempt(() =>
                arrangeChoices({
                    title: label,
                    choices: [{ value: 1, label, default: true, danger: true }],
                }),
            ),
            attempt(() =>
                arrangeChoices({
                    title: label,
                    choices: [
                        { value: 1, label, default: true },
                        { value: 2, label, default: true },
                    ],
                }),
            ),
        ]
    })
    expect(errors.every((error) => error.includes('Error'))).toBe(true)
})
