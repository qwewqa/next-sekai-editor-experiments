import { expect, test, type BrowserContext, type Page } from '@playwright/test'

// The file state: the label's "•" and title, the one chip slot and
// its dialogs, "Download not confirmed", the close prompts and their setting, and Help's file lines.

const prefix = 'sonolus-next-sekai-editor.'

/** Seeds every page of the context: the storage hooks, a fixed version, the panels away. */
const seed = (context: BrowserContext, platform?: object, extra: Record<string, string> = {}) =>
    context.addInitScript(
        ({ platform, extra }) => {
            localStorage.setItem('nse.test.storage', '{}')
            localStorage.setItem(
                'nse.test.version',
                JSON.stringify({ appVersion: '0.6.0', atTag: true }),
            )
            localStorage.setItem(
                'sonolus-next-sekai-editor.lastAppVersion',
                JSON.stringify('0.6.0'),
            )
            localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
            localStorage.setItem('sonolus-next-sekai-editor.showSidebar', 'false')
            if (platform) localStorage.setItem('nse.test.platform', JSON.stringify(platform))
            for (const [key, value] of Object.entries(extra)) localStorage.setItem(key, value)
        },
        { platform, extra },
    )

const visit = async (page: Page) => {
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await expect
        .poll(
            () =>
                page.evaluate(async () => {
                    const { startupGate } =
                        (await import('/src/startup/gate.ts')) as typeof import('../../src/startup/gate')
                    return startupGate.phase
                }),
            { timeout: 20_000 },
        )
        .toBe('done')
    // The pill is out of the way of the status bar's clicks.
    await page.keyboard.press('Escape')
}

const settled = (page: Page) =>
    expect
        .poll(() =>
            page.evaluate(() => {
                const flusher = window.nseFlushTest!.flusher
                return !flusher.hasPending && !!flusher.session?.stored
            }),
        )
        .toBe(true)

/** A dialog ignores presses in its first moments. */
const afterGuard = (page: Page) => page.waitForTimeout(400)

const label = (page: Page) => page.locator('[data-status-text]')
const button = (page: Page) => page.locator('[data-status-label]')
const chip = (page: Page) => page.locator('[data-file-chip]')
/** The chip's visible text, omitted in compact bars. */
const chipShown = (page: Page) => chip(page).locator('span:visible')

const statusGeometry = (page: Page) =>
    page.locator('[data-status-bar]').evaluate((bar) => {
        const rect = (element: Element) => {
            const { left, right, top, bottom, width, height } = element.getBoundingClientRect()
            return { left, right, top, bottom, width, height }
        }
        const visibleText = (element: HTMLElement) => {
            const text = element.firstChild!
            const box = element.getBoundingClientRect()
            const clipped = element.scrollWidth > element.clientWidth
            const ellipsis = clipped ? parseFloat(getComputedStyle(element).fontSize) : 0
            const range = document.createRange()
            let visible = ''
            for (let i = 0; i < text.textContent!.length; i++) {
                range.setStart(text, i)
                range.setEnd(text, i + 1)
                const character = range.getBoundingClientRect()
                if (character.left >= box.left && character.right <= box.right - ellipsis + 0.5)
                    visible += text.textContent![i]
            }
            return visible.trim()
        }
        const title = bar.querySelector<HTMLElement>('[data-status-tool]')
        return {
            bar: rect(bar),
            items: [...bar.children].map(rect),
            title: title ? { ...rect(title), cut: title.scrollWidth > title.clientWidth } : null,
            scopes: [...bar.querySelectorAll<HTMLElement>('.status-chip')].map((scope) => ({
                ...rect(scope),
                name: visibleText(scope.querySelector<HTMLElement>('[data-status-part="name"]')!),
            })),
            file: visibleText(bar.querySelector<HTMLElement>('[data-status-file]')!),
            chip: [...bar.querySelectorAll('[data-file-chip] > *')].map(rect),
        }
    })

/** Binds the open session to a file at a file event, with the live state as the file's. */
const bindFile = (
    page: Page,
    file: { name: string; event: 'saved' | 'downloaded' | 'opened'; at?: number },
) =>
    page.evaluate(async (file) => {
        const { bindFile } =
            (await import('/src/editor/file/state.ts')) as typeof import('../../src/editor/file/state')
        const { liveState } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        bindFile({ ...file, at: file.at ?? Date.now() }, liveState.value)
    }, file)

const edit = (page: Page, initialLife: number) =>
    page.evaluate(async (initialLife) => {
        const { pushState, state } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        const { initialLife: operation } =
            (await import('/tests/helpers/historySteps.ts')) as typeof import('../helpers/historySteps')
        pushState(operation(state.value.initialLife, initialLife), { ...state.value, initialLife })
    }, initialLife)

const undo = (page: Page) =>
    page.evaluate(async () => {
        const { undoState } =
            (await import('/src/history/index.ts')) as typeof import('../../src/history')
        undoState()
    })

const finding = (page: Page, kind: 'changed' | 'newer' | 'missing' | undefined) =>
    page.evaluate(async (kind) => {
        const { setDiskFinding } =
            (await import('/src/editor/file/state.ts')) as typeof import('../../src/editor/file/state')
        setDiskFinding(kind)
    }, kind)

/** Whether closing the page now would raise the browser's prompt (the handler held the event). */
const prompts = (page: Page) =>
    page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
    })

test.describe('the label and the title', () => {
    test('a bound session shows a bullet while its content differs from the file event', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await expect(label(page)).toHaveText('coconut.nxsp')
        await expect(page).toHaveTitle('coconut.nxsp – Next SEKAI Editor')

        await edit(page, 990)
        await expect(label(page)).toHaveText('coconut.nxsp •')
        await expect(page).toHaveTitle('coconut.nxsp • – Next SEKAI Editor')
        await expect(button(page)).toHaveAccessibleName(
            'coconut, changed since coconut.nxsp was saved',
        )

        // The same content reached another way is unchanged.
        await undo(page)
        await expect(label(page)).toHaveText('coconut.nxsp')
        await edit(page, 990)
        await edit(page, 1000)
        await expect(label(page)).toHaveText('coconut.nxsp')
    })

    test('a selection change is no change', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await page.evaluate(async () => {
            const { replaceState, state } =
                (await import('/src/history/index.ts')) as typeof import('../../src/history')
            replaceState({ ...state.value, selectedEntities: [] })
        })
        await expect(label(page)).toHaveText('coconut.nxsp')
    })

    test('a bound session is named by its file, whatever its Name, and the bullet follows', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await page.evaluate(async () => {
            const { session } =
                (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
            session.value = { ...session.value, name: 'Coconut (Master)' }
        })
        await edit(page, 990)
        await expect(label(page)).toHaveText('coconut.nxsp •')
        await expect(page).toHaveTitle('coconut.nxsp • – Next SEKAI Editor')
        await expect(button(page)).toHaveAccessibleName(
            'coconut, changed since coconut.nxsp was saved',
        )
    })

    test('the file name shows once when the name is its stem, as in every file the apps save', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        // An unnamed session saved as coconut-v2.nxsp shows the file name alone.
        await bindFile(page, { name: 'coconut-v2.nxsp', event: 'saved' })
        await expect(label(page)).toHaveText('coconut-v2.nxsp')
        await expect(page).toHaveTitle('coconut-v2.nxsp – Next SEKAI Editor')
        // A Name equal to the bound file's stem is the same name.
        await page.evaluate(async () => {
            const { session } =
                (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
            session.value = { ...session.value, name: 'coconut-v2' }
        })
        await expect(label(page)).toHaveText('coconut-v2.nxsp')
    })

    test('a download browser adds the state, and a download reads "since download"', async ({
        page,
        context,
    }) => {
        await seed(context, { fileSystemAccess: false }, { [`${prefix}downloadConfirmed`]: 'true' })
        await visit(page)
        // Not today, and in this year: a date reads without its year.
        const at = new Date(new Date().getFullYear(), 2, 3, 12).getTime()
        await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded', at })
        await expect(label(page)).toHaveText('coconut.nxsp · downloaded Mar 3')
        await edit(page, 990)
        await expect(label(page)).toHaveText('coconut.nxsp · downloaded Mar 3 •')
        await expect(button(page)).toHaveAccessibleName(
            'coconut, changed since coconut.nxsp was downloaded',
        )
    })

    test.describe('on a phone', () => {
        test.use({ viewport: { width: 360, height: 700 } })

        test('the download state is left out, and the bullet stays', async ({ page, context }) => {
            await seed(
                context,
                { fileSystemAccess: false },
                { [`${prefix}downloadConfirmed`]: 'true' },
            )
            await visit(page)
            await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded' })
            await edit(page, 990)
            await expect(page.locator('[data-status-state]')).toBeHidden()
            await expect(page.locator('[data-status-changed]')).toBeVisible()
        })

        test('a compact bound label gives the file its name space and protects the changed bullet', async ({
            page,
            context,
        }) => {
            await page.setViewportSize({ width: 320, height: 568 })
            await seed(context)
            await visit(page)
            await bindFile(page, { name: 'coconut-long-working-copy.nxsp', event: 'saved' })
            await page.evaluate(async () => {
                const { session } =
                    (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
                session.value = { ...session.value, name: 'A Very Long Distinct Display Name' }
            })
            await edit(page, 990)
            await page.evaluate(async () => {
                const { raised } =
                    (await import('/src/editor/file/state.ts')) as typeof import('../../src/editor/file/state')
                raised.notStored.value = true
            })
            await expect(page.locator('[data-status-name]')).toHaveCount(0)
            await expect(page.locator('[data-status-file]')).toHaveText(
                'coconut-long-working-copy.nxsp',
            )
            await expect(page.locator('[data-status-changed]')).toBeVisible()
            await expect(button(page)).toHaveAccessibleName(
                'coconut-long-working-copy, changed since coconut-long-working-copy.nxsp was saved',
            )
            const geometry = await statusGeometry(page)
            expect(geometry.file).toMatch(/^coconut/)
            expect(geometry.title).toBeNull()
            expect(geometry.bar.height).toBe(32)
        })

        for (const locale of ['ja', 'tr'])
            test(`a compact ${locale} separate copy protects its fixed meaning after a long filename`, async ({
                page,
                context,
            }) => {
                await page.setViewportSize({ width: 320, height: 568 })
                await seed(context, { os: 'ios', engine: 'webkit' })
                await visit(page)
                const expected = await page.evaluate(async (locale) => {
                    const { session } =
                        (await import('/src/history/session.ts')) as typeof import('../../src/history/session')
                    const { settings } =
                        (await import('/src/settings.ts')) as typeof import('../../src/settings')
                    const { i18n } =
                        (await import('/src/i18n/index.ts')) as typeof import('../../src/i18n')
                    const { raised } =
                        (await import('/src/editor/file/state.ts')) as typeof import('../../src/editor/file/state')
                    settings.locale = locale
                    session.value = {
                        ...session.value,
                        name: 'A Long Separate Session Name',
                        copyOf: {
                            name: 'coconut-source-with-an-extremely-long-file-name.nxsp',
                            bound: true,
                        },
                    }
                    raised.notStored.value = true
                    return i18n.value.status.separateCopyShort
                }, locale)
                const fixed = page.locator('[data-status-state]')
                await expect(fixed).toHaveText(expected)
                const metrics = await fixed.evaluate((element) => {
                    const label = element.closest('button')!.getBoundingClientRect()
                    const range = document.createRange()
                    range.selectNodeContents(element)
                    return [...range.getClientRects()].map((rect) => ({
                        inside:
                            rect.left >= label.left &&
                            rect.right <= label.right &&
                            rect.top >= label.top &&
                            rect.bottom <= label.bottom,
                    }))
                })
                expect(metrics.length).toBeGreaterThan(0)
                expect(metrics.every(({ inside }) => inside)).toBe(true)
                await expect(button(page)).toHaveAccessibleName(
                    /coconut-source-with-an-extremely-long-file-name\.nxsp/,
                )
                // The file line is the status label's text.
                const full = await page.evaluate(
                    async () =>
                        (
                            (await import('/src/editor/labelText.ts')) as typeof import('../../src/editor/labelText')
                        ).statusText.value,
                )
                await button(page).click()
                await expect(page.locator('[data-status-summary]')).toHaveText(full)
                await expect(page.locator('[data-status-summary]')).toContainText(
                    'coconut-source-with-an-extremely-long-file-name.nxsp',
                )
                await page.keyboard.press('Escape')
            })
    })

    test.describe('touch interactions', () => {
        test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

        test('warning arrival keeps the chart fixed and every button owns its target', async ({
            page,
            context,
        }) => {
            await seed(context)
            await visit(page)
            await page.evaluate(async () => {
                const { liveState, replaceState } =
                    (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
                const { settings } =
                    (await import('/src/settings.ts')) as typeof import('../../src/settings')
                replaceState({ ...liveState.value, isDynamicStages: true })
                settings.groupsPosition = 'disabled'
                settings.stagesPosition = 'disabled'
            })
            await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
            const bar = page.locator('[data-status-bar]')
            const before = await bar.boundingBox()
            const chart = await page.locator('canvas.editor-chart').boundingBox()
            expect(before!.height).toBe(32)
            await finding(page, 'newer')
            await expect(chip(page)).toBeVisible()
            expect(await bar.boundingBox()).toEqual(before)
            expect(await page.locator('canvas.editor-chart').boundingBox()).toEqual(chart)
            const buttons = bar.locator(':scope > button')
            await expect(buttons).toHaveCount(4)
            const targets = await buttons.evaluateAll((elements) =>
                elements.map((element) => {
                    const box = element.getBoundingClientRect()
                    const points = [
                        [box.left + 1, box.top + box.height / 2],
                        [box.right - 1, box.top + box.height / 2],
                        [box.left + box.width / 2, box.top + 1],
                        [box.left + box.width / 2, box.bottom - 1],
                    ]
                    return {
                        width: box.width,
                        height: box.height,
                        left: box.left,
                        right: box.right,
                        top: box.top,
                        ownEdges: points.every(
                            ([x, y]) =>
                                document.elementFromPoint(x!, y!)?.closest('button') === element,
                        ),
                        pseudo: getComputedStyle(element, '::before').content,
                    }
                }),
            )
            for (const [index, target] of targets.entries()) {
                expect(target.width).toBeGreaterThan(0)
                expect(target.height).toBe(32)
                expect(target.ownEdges).toBe(true)
                expect(target.pseudo).toBe('none')
                if (index && target.top === targets[index - 1]!.top)
                    expect(target.left - targets[index - 1]!.right).toBeGreaterThanOrEqual(4)
            }
            expect(targets[0]!.top).toBe(targets[1]!.top)
            expect(targets[2]!.top).toBe(targets[0]!.top)
            expect(targets[3]!.top).toBe(targets[2]!.top)
            const dialogs = [
                'Level Info',
                '"coconut.nxsp" Changed',
                'Manage Groups',
                'Manage Stages',
            ]
            for (const [index, title] of dialogs.entries()) {
                const control = buttons.nth(index)
                for (const edge of ['left', 'center', 'right'] as const) {
                    const box = (await control.boundingBox())!
                    await page.touchscreen.tap(
                        box.x +
                            (edge === 'left'
                                ? 1
                                : edge === 'right'
                                  ? box.width - 1
                                  : box.width / 2),
                        box.y + box.height / 2,
                    )
                    await expect(
                        page.getByRole('dialog', { name: title, exact: true }),
                    ).toBeVisible()
                    await page.keyboard.press('Escape')
                    await expect(page.getByRole('dialog')).toHaveCount(0)
                }
            }
            await page.emulateMedia({ forcedColors: 'active' })
            await page.keyboard.press('Shift')
            for (const control of await buttons.all()) {
                await control.focus()
                await page.keyboard.press('Shift+Tab')
                await page.keyboard.press('Tab')
                await expect(control).toBeFocused()
                expect(
                    await control.evaluate((element) => ({
                        visible: element.matches(':focus-visible'),
                        outline: getComputedStyle(element).outlineStyle,
                        width: getComputedStyle(element).outlineWidth,
                    })),
                ).toEqual({ visible: true, outline: 'solid', width: '4px' })
            }
            await buttons.first().focus()
            for (let index = 0; index < 4; index++) {
                await expect(buttons.nth(index)).toBeFocused()
                if (index < 3) await page.keyboard.press('Tab')
            }
            await finding(page, undefined)
            await expect(chip(page)).toBeHidden()
            expect(await bar.boundingBox()).toEqual(before)
            expect(await page.locator('canvas.editor-chart').boundingBox()).toEqual(chart)
        })
    })

    test.describe('full status disclosure', () => {
        test.use({ viewport: { width: 320, height: 568 }, hasTouch: true })

        test('touch, toolbar and command open the same selectable wrapping identity without an edit', async ({
            page,
            context,
        }) => {
            await seed(context)
            await visit(page)
            // The file names the session, so the long identity is the file’s own name.
            const file = `coconut-${'abcdefghij'.repeat(60)}.nxsp`
            await bindFile(page, { name: file, event: 'saved' })
            await page.evaluate(async () => {
                const { settings } =
                    (await import('/src/settings.ts')) as typeof import('../../src/settings')
                settings.toolbar = [['properties']]
            })
            await edit(page, 990)
            // The file line is the status label's text.
            const full = await page.evaluate(
                async () =>
                    (
                        (await import('/src/editor/labelText.ts')) as typeof import('../../src/editor/labelText')
                    ).statusText.value,
            )
            const seq = () =>
                page.evaluate(() => {
                    const flusher = window.nseFlushTest!.flusher
                    return flusher.newestSeq(flusher.session!)
                })
            const before = await seq()
            for (const route of ['status', 'toolbar', 'command']) {
                if (route === 'status') await button(page).tap()
                else if (route === 'toolbar')
                    await page.locator('[data-editor-toolbar] button[title="Level Info"]').click()
                else
                    await page.evaluate(async () => {
                        const { levelInfo } =
                            (await import('/src/editor/commands/levelInfo/index.ts')) as typeof import('../../src/editor/commands/levelInfo')
                        const { runCommand } =
                            (await import('/src/editor/commands/runCommand.ts')) as typeof import('../../src/editor/commands/runCommand')
                        void runCommand(levelInfo, 'button')
                    })
                const dialog = page.getByRole('dialog', { name: 'Level Info' })
                const summary = page.locator('[data-status-summary]')
                await expect(summary).toHaveText(full)
                await expect(page.getByRole('dialog')).toHaveCount(1)
                if (route !== 'command') await expect(dialog).toBeFocused()
                const metrics = await summary.evaluate((element) => {
                    const paragraph = element.getBoundingClientRect()
                    const range = document.createRange()
                    range.selectNodeContents(element)
                    const lines = [...range.getClientRects()]
                    const glyphs: DOMRect[] = []
                    const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
                    while (text.nextNode()) {
                        const node = text.currentNode
                        for (let offset = 0; offset < node.textContent!.length; offset++) {
                            if (/\s/u.test(node.textContent![offset]!)) continue
                            const glyph = document.createRange()
                            glyph.setStart(node, offset)
                            glyph.setEnd(node, offset + 1)
                            glyphs.push(...glyph.getClientRects())
                        }
                    }
                    getSelection()!.removeAllRanges()
                    getSelection()!.addRange(range)
                    const body = element.closest<HTMLElement>('.overflow-y-auto')!
                    body.scrollTop = body.scrollHeight
                    return {
                        selected: getSelection()!.toString(),
                        lines: lines.length,
                        horizontalFit:
                            glyphs.length > 0 &&
                            glyphs.every(
                                (rect) =>
                                    rect.left >= paragraph.left - 0.5 &&
                                    rect.right <= paragraph.right + 0.5,
                            ),
                        horizontalScroll: body.scrollWidth > body.clientWidth,
                        scrollable: body.scrollHeight > body.clientHeight,
                        reachedEnd: body.scrollTop + body.clientHeight >= body.scrollHeight - 1,
                        userSelect: getComputedStyle(element).userSelect,
                        overflowWrap: getComputedStyle(element).overflowWrap,
                    }
                })
                expect(metrics).toMatchObject({
                    selected: full,
                    horizontalFit: true,
                    horizontalScroll: false,
                    scrollable: true,
                    reachedEnd: true,
                    userSelect: 'text',
                    overflowWrap: 'anywhere',
                })
                expect(metrics.lines).toBeGreaterThan(2)
                if (route === 'status') await page.keyboard.press('Escape')
                else if (route === 'toolbar')
                    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
                else {
                    await afterGuard(page)
                    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
                }
                await expect(page.getByRole('dialog')).toHaveCount(0)
                expect(await seq()).toBe(before)
            }
            await button(page).tap()
            await page.getByRole('spinbutton', { name: 'Initial Life', exact: true }).fill('995')
            await afterGuard(page)
            await page.getByRole('button', { name: 'Confirm', exact: true }).click()
            expect(
                await page.evaluate(
                    async () =>
                        (
                            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
                        ).liveState.value.initialLife,
                ),
            ).toBe(995)
            await undo(page)
            expect(
                await page.evaluate(
                    async () =>
                        (
                            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
                        ).liveState.value.initialLife,
                ),
            ).toBe(990)
        })

        test('a peek discloses the live identity beside disabled historical life without restoring it', async ({
            page,
            context,
        }) => {
            await seed(context)
            await visit(page)
            await bindFile(page, { name: 'coconut-current-working-copy.nxsp', event: 'saved' })
            await edit(page, 990)
            await edit(page, 980)
            await settled(page)
            const before = await page.evaluate(async () => {
                const flusher = window.nseFlushTest!.flusher
                const { peekEntry, entryKey } =
                    (await import('/src/history/peek.ts')) as typeof import('../../src/history/peek')
                const seq = flusher.newestSeq(flusher.session!)
                await peekEntry(entryKey(flusher.session!.id, seq - 1))
                return seq
            })
            // The file line is the status label's text.
            const full = await page.evaluate(
                async () =>
                    (
                        (await import('/src/editor/labelText.ts')) as typeof import('../../src/editor/labelText')
                    ).statusText.value,
            )
            await button(page).tap()
            await expect(page.locator('[data-status-summary]')).toHaveText(full)
            const life = page.getByRole('spinbutton', { name: 'Initial Life', exact: true })
            await expect(life).toHaveValue('990')
            await expect(life).toBeDisabled()
            expect(
                await page
                    .locator('[data-status-summary]')
                    .evaluate((element) => element.closest('fieldset')),
            ).toBeNull()
            await afterGuard(page)
            await page.getByRole('button', { name: 'OK', exact: true }).click()
            const after = await page.evaluate(async () => {
                const { state, liveState, isPeeking } =
                    (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
                const flusher = window.nseFlushTest!.flusher
                return {
                    shown: state.value.initialLife,
                    live: liveState.value.initialLife,
                    peeking: isPeeking.value,
                    seq: flusher.newestSeq(flusher.session!),
                }
            })
            expect(after).toEqual({ shown: 990, live: 980, peeking: true, seq: before })
        })
    })
})

test.describe('the chip', () => {
    test('a download with no recorded time names no time, never "()"', async ({
        page,
        context,
    }) => {
        await seed(context, { fileSystemAccess: false })
        await visit(page)
        await page.evaluate(async () => {
            const { bindFile } =
                (await import('/src/editor/file/state.ts')) as typeof import('../../src/editor/file/state')
            const { liveState } =
                (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
            bindFile({ name: 'coconut.nxsp', event: 'downloaded' }, liveState.value)
        })
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notConfirmed')
        await expect(chip(page)).toHaveAccessibleName(
            'Check that coconut.nxsp finished downloading.',
        )
        // The label leaves out an event it cannot date.
        await expect(label(page)).not.toContainText('downloaded')
        await expect(label(page)).not.toContainText('1970')
    })

    test('a download not yet confirmed in this browser shows the chip, and I Have the File clears it', async ({
        page,
        context,
    }) => {
        await seed(context, { fileSystemAccess: false })
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded' })
        await expect(chipShown(page)).toHaveText('Download not confirmed')
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notConfirmed')
        await expect(chip(page)).toHaveAccessibleName(
            /^Check that coconut\.nxsp finished downloading \(.+\)\.$/,
        )
        // Not a change: no bullet.
        await expect(label(page)).not.toContainText('•')

        await chip(page).click()
        const dialog = page.getByRole('dialog', { name: 'Download Not Confirmed' })
        await expect(dialog).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Download Again' })).toBeFocused()
        await afterGuard(page)
        await dialog.getByRole('button', { name: 'I Have the File' }).click()
        await expect(chip(page)).toBeHidden()
        expect(
            await page.evaluate((key) => localStorage.getItem(key), `${prefix}downloadConfirmed`),
        ).toBe('true')

        // Later downloads in this browser need no confirming.
        await bindFile(page, { name: 'melt.nxsp', event: 'downloaded' })
        await expect(chip(page)).toBeHidden()
    })

    test('every download on an iPhone or iPad is unconfirmed, whatever the flag says', async ({
        page,
        context,
    }) => {
        await seed(
            context,
            { fileSystemAccess: false, os: 'ios', engine: 'webkit' },
            { [`${prefix}downloadConfirmed`]: 'true' },
        )
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded' })
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notConfirmed')
        await chip(page).click()
        await afterGuard(page)
        await page
            .getByRole('dialog', { name: 'Download Not Confirmed' })
            .getByRole('button', { name: 'I Have the File' })
            .click()
        await expect(chip(page)).toBeHidden()
        // I Have the File is for this session's file only.
        await bindFile(page, { name: 'melt.nxsp', event: 'downloaded' })
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'notConfirmed')
    })

    for (const [name, platform] of [
        ['macOS Safari', { os: 'macos', engine: 'webkit', fileSystemAccess: false }],
        ['Firefox', { os: 'linux', engine: 'firefox', fileSystemAccess: false }],
        ['Chromium on Android', { os: 'android', engine: 'chromium', fileSystemAccess: false }],
    ] as const)
        test(`${name}: the first download is unconfirmed until one is confirmed in this browser`, async ({
            page,
            context,
        }) => {
            await seed(context, platform)
            await visit(page)
            await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded' })
            await expect(chip(page)).toHaveAttribute('data-file-chip', 'notConfirmed')
            expect(await prompts(page)).toBe(true)
            await chip(page).click()
            await afterGuard(page)
            await page
                .getByRole('dialog', { name: 'Download Not Confirmed' })
                .getByRole('button', { name: 'I Have the File' })
                .click()
            await expect(chip(page)).toBeHidden()
            await bindFile(page, { name: 'melt.nxsp', event: 'downloaded' })
            await expect(chip(page)).toBeHidden()
            await edit(page, 990)
            await undo(page)
            expect(await prompts(page)).toBe(false)
        })

    test('Not stored comes first, and the others are lines for its dialog', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await finding(page, 'changed')
        await expect(chipShown(page)).toHaveText('Changed on disk')
        await page.evaluate(async () => {
            const { raised } =
                (await import('/src/editor/file/state.ts')) as typeof import('../../src/editor/file/state')
            raised.notStored.value = true
        })
        await expect(chipShown(page)).toHaveText('Not stored')
        await expect(chip(page)).toHaveAccessibleName(
            'Changes are not being stored in this browser.',
        )
        // The label takes the warning colour too.
        await expect(button(page)).toHaveClass(/text-warning/)
        const rest = await page.evaluate(async () => {
            const { chip } =
                (await import('/src/editor/file/state.ts')) as typeof import('../../src/editor/file/state')
            return chip.value?.rest
        })
        expect(rest).toEqual(['changedOnDisk'])
    })

    test('an edit moves a download from the chip to "changed since download"', async ({
        page,
        context,
    }) => {
        await seed(context, { fileSystemAccess: false })
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded' })
        await expect(chip(page)).toBeVisible()
        await edit(page, 990)
        await expect(chip(page)).toBeHidden()
        await expect(label(page)).toContainText('•')
    })

    test('the first state by priority is the chip, and the others are lines in its dialog', async ({
        page,
        context,
    }) => {
        await seed(context, { fileSystemAccess: false })
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded' })
        await finding(page, 'changed')
        await expect(chipShown(page)).toHaveText('Changed on disk')
        await expect(chip(page)).toHaveAttribute('data-file-chip', 'changedOnDisk')
        await expect(label(page)).toContainText('changed on disk')
        await chip(page).click()
        const dialog = page.getByRole('dialog', { name: '"coconut.nxsp" Changed' })
        await expect(dialog).toContainText(
            '“coconut.nxsp” has changed since you opened or saved it here.',
        )
        await expect(dialog).toContainText('Check that coconut.nxsp finished downloading')
        // Keep Editing is the safe default, in Cancel's place.
        await expect(dialog.getByRole('button', { name: 'Keep Editing' })).toBeFocused()
        await expect(dialog.getByRole('button', { name: 'Open the Other Version' })).toBeVisible()
        await expect(dialog.getByText('Your changes stay in Recent Sessions.')).toBeVisible()
        await afterGuard(page)
        await dialog.getByRole('button', { name: 'Keep Editing' }).click()

        await finding(page, 'missing')
        await expect(chipShown(page)).toHaveText('File missing')
        await finding(page, 'newer')
        await expect(chipShown(page)).toHaveText('Newer on disk')
        await finding(page, undefined)
        await expect(chipShown(page)).toHaveText('Download not confirmed')
    })

    test('a missing file opens the not-found dialog, which offers Save As…', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await finding(page, 'missing')
        await chip(page).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog).toContainText('“coconut.nxsp” could not be found.')
        await expect(dialog.getByRole('button', { name: 'Save As…' })).toBeFocused()
    })

    test('a finding about another session is no state of this one', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await finding(page, 'changed')
        await expect(chip(page)).toBeVisible()
        await page.evaluate(async () => {
            const { resetState } =
                (await import('/src/history/index.ts')) as typeof import('../../src/history')
            resetState(false)
        })
        await expect(chip(page)).toBeHidden()
    })

    test.describe('on a phone', () => {
        test.use({ viewport: { width: 360, height: 700 } })

        test('the compact state icon keeps the full sentence and opens its dialog', async ({
            page,
            context,
        }) => {
            await seed(context)
            await visit(page)
            await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
            await finding(page, 'changed')
            await expect(chipShown(page)).toHaveCount(0)
            expect((await chip(page).boundingBox())!.width).toBe(24)
            await expect(chip(page)).toHaveAccessibleName(
                '“coconut.nxsp” has changed on disk since you opened or saved it here.',
            )
            const box = (await chip(page).boundingBox())!
            const bar = (await page.locator('.status-chip').first().boundingBox())!
            expect(box.x + box.width).toBeLessThanOrEqual(360)
            expect(bar.x + bar.width).toBeLessThanOrEqual(360)
            await chip(page).click()
            await expect(page.getByRole('dialog')).toContainText('coconut.nxsp')
            await expect(
                page.getByRole('button', { name: 'Keep Editing', exact: true }),
            ).toBeVisible()
            await page.keyboard.press('Escape')
            await button(page).click()
            await expect(page.getByRole('dialog', { name: 'Level Info' })).toBeVisible()
        })

        test('compact spacing preserves useful file and scope names beside a warning', async ({
            page,
            context,
        }) => {
            await seed(context)
            await visit(page)
            await page.evaluate(async () => {
                const { liveState, replaceState } =
                    (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
                replaceState({ ...liveState.value, isDynamicStages: true })
            })
            await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
            await finding(page, 'newer')
            await expect(page.locator('.status-chip')).toHaveCount(2)
            const geometry = await statusGeometry(page)
            expect(geometry.title).toBeNull()
            expect(geometry.scopes.map((scope) => scope.name)).toEqual(['All Groups', 'All Stages'])
            expect(geometry.file).toMatch(/^coc/)
            expect(geometry.scopes[0]!.width).toBeCloseTo(geometry.scopes[1]!.width, 1)
            for (const item of [...geometry.items, ...geometry.chip]) {
                expect(item.left).toBeGreaterThanOrEqual(geometry.bar.left)
                expect(item.right).toBeLessThanOrEqual(geometry.bar.right)
            }
        })

        test('a long localized tool is omitted while useful file and scope text stays', async ({
            page,
            context,
        }) => {
            await seed(context)
            await visit(page)
            await page.evaluate(async () => {
                const { liveState, replaceState } =
                    (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
                const { switchToolTo } =
                    (await import('/src/editor/tools/index.ts')) as typeof import('../../src/editor/tools')
                const { settings } =
                    (await import('/src/settings.ts')) as typeof import('../../src/settings')
                replaceState({ ...liveState.value, isDynamicStages: true })
                settings.locale = 'fr'
                switchToolTo('stageTransformEvent')
            })
            await bindFile(page, { name: 'coconut-long-working-copy.nxsp', event: 'saved' })
            await finding(page, 'newer')
            await expect(chipShown(page)).toHaveCount(0)
            await expect(chip(page)).toHaveAttribute('data-file-chip', 'newerOnDisk')
            await expect(chip(page)).toHaveAccessibleName(
                /une version plus récente est sur le disque\./,
            )
            const geometry = await statusGeometry(page)
            expect(geometry.bar.height).toBe(32)
            expect(geometry.title).toBeNull()
            expect(geometry.file).toMatch(/^coc/)
            expect(geometry.scopes[0]!.width).toBeCloseTo(geometry.scopes[1]!.width, 1)
            for (const scope of geometry.scopes) {
                expect(scope.name.replace(/\W/g, '').length).toBeGreaterThanOrEqual(4)
            }
            for (const item of geometry.items) {
                expect(item.left).toBeGreaterThanOrEqual(geometry.bar.left)
                expect(item.right).toBeLessThanOrEqual(geometry.bar.right)
            }
        })
    })
})

test.describe('single-line disclosures', () => {
    test('a Not stored chip with no storage cause lists the lower states and offers Save', async ({
        page,
        context,
    }) => {
        await page.setViewportSize({ width: 320, height: 568 })
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await finding(page, 'changed')
        await page.evaluate(async () => {
            const { raised } =
                (await import('/src/editor/file/state.ts')) as typeof import('../../src/editor/file/state')
            raised.notStored.value = true
        })
        await chip(page).click()
        const dialog = page.getByRole('dialog', { name: 'Changes Not Stored' })
        await expect(dialog).toContainText('Changes are not being stored in this browser.')
        await expect(dialog).toContainText(
            '“coconut.nxsp” has changed on disk since you opened or saved it here.',
        )
        await expect(dialog).not.toContainText('Leaving will discard')
        await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(1)
        await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused()
        await page.keyboard.press('Escape')
        await button(page).click()
        await expect(page.getByRole('dialog', { name: 'Level Info' })).toBeVisible()
    })
})

test.describe('the close prompts', () => {
    test('a bound session prompts once changed, not while unchanged', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        expect(await prompts(page)).toBe(false)
        await edit(page, 990)
        await settled(page)
        expect(await prompts(page)).toBe(true)
        await undo(page)
        await settled(page)
        expect(await prompts(page)).toBe(false)
    })

    test('the setting turns the prompt off', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'saved' })
        await edit(page, 990)
        await settled(page)
        expect(await prompts(page)).toBe(true)
        await page.evaluate(async () => {
            const { settings } =
                (await import('/src/settings.ts')) as typeof import('../../src/settings')
            settings.confirmCloseUnsavedFile = false
        })
        expect(await prompts(page)).toBe(false)
    })

    test('an unbound session prompts after an edit, not before', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        expect(await prompts(page)).toBe(false)
        await edit(page, 990)
        expect(await prompts(page)).toBe(true)
    })

    test('an unconfirmed download prompts until I Have the File', async ({ page, context }) => {
        await seed(context, { fileSystemAccess: false })
        await visit(page)
        await bindFile(page, { name: 'coconut.nxsp', event: 'downloaded' })
        expect(await prompts(page)).toBe(true)
        await chip(page).click()
        await afterGuard(page)
        await page
            .getByRole('dialog', { name: 'Download Not Confirmed' })
            .getByRole('button', { name: 'I Have the File' })
            .click()
        expect(await prompts(page)).toBe(false)
    })

    test('Settings › Local Data holds the setting, and iPhone and iPad hide it', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        await page.evaluate(async () => {
            const { openSettings } =
                (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
            openSettings('localData')
        })
        const row = page.getByRole('switch', { name: 'Ask Before Closing with Unsaved Changes' })
        await expect(row).toHaveAttribute('aria-checked', 'true')
        await row.click()
        await expect(row).toHaveAttribute('aria-checked', 'false')

        const ios = await context.newPage()
        await seed(context, { os: 'ios', engine: 'webkit' })
        await visit(ios)
        await ios.evaluate(async () => {
            const { openSettings } =
                (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
            openSettings('localData')
        })
        await expect(ios.locator('[data-open-history]')).toBeVisible()
        await expect(
            ios.getByRole('switch', { name: 'Ask Before Closing with Unsaved Changes' }),
        ).toHaveCount(0)
    })

    test('the setting follows the platform capabilities, not the operating system', async ({
        page,
        context,
    }) => {
        await seed(context)
        await visit(page)
        const hidden = async (capabilities: Record<string, boolean>) => {
            await page.evaluate(async (capabilities) => {
                const { platform, setPlatformForTests } =
                    (await import('/src/platform/index.ts')) as typeof import('../../src/platform')
                setPlatformForTests({
                    ...platform,
                    capabilities: { ...platform.capabilities, ...capabilities },
                })
                const { openSettings } =
                    (await import('/src/editor/settings/openSettings.ts')) as typeof import('../../src/editor/settings/openSettings')
                openSettings('localData')
            }, capabilities)
            await expect(page.locator('[data-open-history]')).toBeVisible()
            const count = await page
                .getByRole('switch', { name: 'Ask Before Closing with Unsaved Changes' })
                .count()
            await page.keyboard.press('Escape')
            await expect(page.locator('[data-open-history]')).toHaveCount(0)
            return count === 0
        }
        // The web's own values show it, as before.
        expect(await hidden({})).toBe(false)
        // Downloads that are never confirmed mean no close prompt to ask about.
        expect(await hidden({ unconfirmedDownloads: true })).toBe(true)
        // The setting is the web's own: the apps have their own close handling.
        expect(await hidden({ browserStorage: false })).toBe(true)
    })
})

test.describe('Help', () => {
    const help = async (page: Page) => {
        await page.evaluate(async () => {
            const { commands } =
                (await import('/src/editor/commands/index.ts')) as typeof import('../../src/editor/commands')
            const { runCommand } =
                (await import('/src/editor/commands/runCommand.ts')) as typeof import('../../src/editor/commands/runCommand')
            await runCommand(commands.help, 'button')
        })
        return page.getByRole('dialog', { name: 'Help' })
    }

    test('the file section says how to move work', async ({ page, context }) => {
        await seed(context)
        await visit(page)
        const dialog = await help(page)
        await expect(dialog).toContainText(
            'To move work to another device, save it as a project file, then open the file there.',
        )
    })
})
