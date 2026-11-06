import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

const selection = (page: Page) => page.locator('#properties-section-selection')

const open = async (
    page: Page,
    locale: string,
    rightDockWidth: number,
    // The first head's connector shows Fullscreen, the others Default.
    mixedPresentation = false,
) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(
        async ({ locale, rightDockWidth, mixedPresentation }) => {
            const { history, store, nextTick, fixtures, settings } = window.editorTest
            const chart = structuredClone(fixtures.interaction)
            // Each head gets a tail, so connector fields show; Critical is mixed.
            chart.slides = chart.slides.map(([head], index) => [
                {
                    ...head!,
                    isCritical: index === 0,
                    ...(mixedPresentation && {
                        connectorPresentation: index === 0 ? 'fullscreen' : 'default',
                    }),
                },
                { ...head!, beat: head!.beat + 1 },
            ])
            history.resetState(false, chart, 0, { sourceName: 'stacking.json' })
            Object.assign(settings, {
                locale,
                showSidebar: true,
                rightDockWidth,
                propertiesConnectorExpanded: true,
            })
            await nextTick()
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...store.getAllEntities()].filter((e) => e.type === 'note'),
            })
            await nextTick()
        },
        { locale, rightDockWidth, mixedPresentation },
    )
    await expect(selection(page).locator('.form-field').first()).toBeVisible()
    // Lets observers settle.
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
}

const stacked = (page: Page) =>
    selection(page)
        .locator('.form-field.form-field-value-stacked .form-field-text')
        .allTextContents()

const field = (page: Page, label: string) =>
    selection(page)
        .locator('.form-field')
        .filter({ has: page.locator('.form-field-text').getByText(label, { exact: true }) })

test('values that would truncate at the narrowest dock go below their label', async ({ page }) => {
    await open(page, 'fr', 260)
    await expect
        .poll(() => stacked(page))
        .toEqual(expect.arrayContaining(['Critique', 'Factice', 'Couche']))
    // Values that fit stay beside the label.
    expect(await stacked(page)).not.toContain('Temps')
    expect(await stacked(page)).not.toContain('Type d’interp.')

    // A click on an on/off value doesn't move its row.
    const dummy = field(page, 'Factice')
    const box = await dummy.boundingBox()
    await dummy.locator('.form-field-toggle > input').click()
    await expect(dummy.locator('.form-field-toggle > input')).toHaveValue('Activé')
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    await expect(dummy).toHaveClass(/form-field-value-stacked/)
    expect(await dummy.boundingBox()).toEqual(box)
})

test('a stacked choice stays a select instead of switching back and forth', async ({ page }) => {
    await open(page, 'ja', 260)
    const presentation = field(page, '表示方式')
    await expect(presentation).toHaveClass(/form-field-value-stacked/)
    await expect(presentation.locator('select')).toBeVisible()
    // The page stays responsive; a layout loop would stall this.
    expect(await page.evaluate(() => 1)).toBe(1)

    // A wider dock gives the segments room beside the label again.
    await page.evaluate(() => (window.editorTest.settings.rightDockWidth = 480))
    await expect(presentation).not.toHaveClass(/form-field-value-stacked/)
    await expect(presentation.locator('[role="radiogroup"]')).toBeVisible()
})

// Only labels whose longest word or phrase does not fit beside the value stack. A value that
// fills its pill within a pixel at this width may stack too: it does where text is drawn a
// fraction wider, as on Linux.
const longWords: Record<string, { labels: string[]; borderline?: string[] }> = {
    en: { labels: [] },
    fr: { labels: [], borderline: ['Traverser la ligne de jugement'] },
    tr: { labels: ['Vuruş Çizgisinden Geçen'] },
}
for (const [locale, { labels, borderline = [] }] of Object.entries(longWords)) {
    test(`${locale} values at a 336 dock, below the default, go below only labels with a word too long`, async ({
        page,
    }) => {
        await open(page, locale, 336)
        await expect
            .poll(async () => (await stacked(page)).filter((label) => !borderline.includes(label)))
            .toEqual(labels)
    })
}

// Japanese is drawn in the machine's own font, so its wrap points vary: the check is fit.
test('ja values at a 336 dock, below the default, fit beside or below their labels', async ({
    page,
}) => {
    await open(page, 'ja', 336)
    const candidates = ['スライドフェイク', 'スライドクリティカル']
    const layout = () =>
        selection(page).evaluate(async (section) => {
            const { valueOverflows, wordsOverflow } = await window.editorTest.appImport<
                typeof import('../../src/modals/form/fieldLayout')
            >('/src/modals/form/fieldLayout.ts')
            const fields = [...section.querySelectorAll<HTMLElement>('.form-field')]
            const texts = fields.map((field) =>
                field.querySelector<HTMLElement>('.form-field-text')!,
            )
            const breaks = wordsOverflow(texts)
            const stacked: string[] = []
            const misfits = fields.flatMap((field, index) => {
                const label = texts[index]!.textContent ?? ''
                if (field.classList.contains('form-field-value-stacked')) stacked.push(label)
                // Beside the value or below it, no phrase breaks inside and the value shows in full.
                const control = field.querySelector<HTMLElement>(
                    '.form-field-row > select, .form-field-row > input[type="number"], .form-field-select > select, .form-field-toggle > input',
                )
                return [
                    ...(breaks[index] ? [`breaks ${label}`] : []),
                    ...(control && valueOverflows(control) ? [`truncates ${label}`] : []),
                ]
            })
            return { stacked, misfits }
        })
    // Only the candidates may go below their label.
    await expect
        .poll(async () => {
            const { stacked, misfits } = await layout()
            return {
                misfits,
                unexpected: stacked.filter((label) => !candidates.includes(label)),
            }
        })
        .toEqual({ misfits: [], unexpected: [] })
})

test('brush values stack too, with remove kept on the label line', async ({ page }) => {
    await open(page, 'ja', 260)
    await page.evaluate(async () => {
        const { history, store, nextTick, settings } = window.editorTest
        settings.propertiesCollapsed = ['selection']
        const note = [...store.getAllEntities()].find((entity) => entity.type === 'note')!
        history.replaceState({ ...history.state.value, selectedEntities: [note] })
        await nextTick()
    })
    await page.keyboard.press('b')
    const tool = page.locator('#workspace-panel-properties')
    await tool.locator('.brush-pick').click()
    const row = tool.locator('[data-brush-key="noteStyle"]')
    await expect(row.locator('.form-field')).toHaveClass(/form-field-value-stacked/)
    const layout = await row.evaluate((row) => {
        const box = (selector: string) => row.querySelector(selector)!.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(row.querySelector('.form-field-text')!)
        return {
            remove: box('.brush-remove').toJSON() as DOMRect,
            text: range.getBoundingClientRect().toJSON() as DOMRect,
            control: box('.form-field-row > :not(.form-field-label)').toJSON() as DOMRect,
        }
    })
    // Beside the label, not over the value below it.
    expect(layout.remove.left).toBeGreaterThanOrEqual(layout.text.right)
    expect(layout.remove.bottom).toBeLessThanOrEqual(layout.control.top)
    expect(
        Math.abs(
            (layout.remove.top + layout.remove.bottom) / 2 -
                (layout.text.top + layout.text.bottom) / 2,
        ),
    ).toBeLessThan(4)
})

test('beside remove at the narrowest dock, no brush label takes three lines', async ({ page }) => {
    await open(page, 'fr', 260)
    await page.evaluate(async () => {
        const { appImport, nextTick, settings } = window.editorTest
        settings.propertiesCollapsed = ['selection']
        const { brushProperties } = await appImport<typeof import('../../src/editor/tools/brush')>(
            '/src/editor/tools/brush/index.ts',
        )
        const { brushFields } = await appImport<
            typeof import('../../src/editor/workspace/properties/fields')
        >('/src/editor/workspace/properties/fields.ts')
        const { defaultGroupId } =
            await appImport<typeof import('../../src/history/groups')>('/src/history/groups.ts')
        const { defaultStageId } =
            await appImport<typeof import('../../src/history/stages')>('/src/history/stages.ts')
        // Every property, so every label shows; the group and stage are the current ones.
        const current: Record<string, unknown> = {
            groupId: defaultGroupId.value,
            stageId: defaultStageId.value,
        }
        brushProperties.value = Object.fromEntries(
            brushFields.map((field) => [field.key, field.brush?.initial ?? current[field.key]]),
        ) as typeof brushProperties.value
        await nextTick()
    })
    await page.keyboard.press('b')
    const labels = page.locator('#workspace-panel-properties [data-brush-key] .form-field-text')
    await expect(labels.first()).toBeVisible()
    const lines = () =>
        labels.evaluateAll((texts) =>
            texts
                .map((text) => ({
                    label: text.textContent,
                    lines: Math.round(
                        text.getBoundingClientRect().height /
                            parseFloat(getComputedStyle(text).lineHeight),
                    ),
                }))
                .filter(({ lines }) => lines > 2),
        )
    await expect.poll(lines).toEqual([])
})

test('a mixed range too long for its pill goes below its label', async ({ page }) => {
    await open(page, 'fr', 260)
    await page.evaluate(async () => {
        const { history, store, nextTick, fixtures } = window.editorTest
        // Beats far apart, with fractions, as a long selection shows them.
        const chart = structuredClone(fixtures.interaction)
        chart.slides = chart.slides.map(([head], index) => [
            { ...head!, beat: 56 + 1 / 3 + index },
            { ...head!, beat: 62.75 + index },
        ])
        history.resetState(false, chart, 0, { sourceName: 'stacking.json' })
        await nextTick()
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...store.getAllEntities()].filter((e) => e.type === 'note'),
        })
        await nextTick()
    })
    const beat = field(page, 'Temps')
    await expect(beat.locator('input')).toHaveAttribute('placeholder', /^\d+\.3333 … \d+\.75$/)
    await expect(beat).toHaveClass(/form-field-value-stacked/)
    const fits = await beat.locator('input').evaluate((input: HTMLInputElement) => {
        const style = getComputedStyle(input)
        const context = document.createElement('canvas').getContext('2d')!
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        const room =
            input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        return context.measureText(input.placeholder).width <= room
    })
    expect(fits).toBe(true)

    // The row holds still while a value is typed.
    await beat.locator('input').click()
    await page.keyboard.type('5')
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    await expect(beat).toHaveClass(/form-field-value-stacked/)
    await page.keyboard.press('Escape')
})

test('a field refits when only its mixed range changes', async ({ page }) => {
    await open(page, 'fr', 260)
    const select = (slide: number) =>
        page.evaluate(async (slide) => {
            const { history, store, nextTick } = window.editorTest
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...store.getAllEntities()].filter(
                    (entity) =>
                        entity.type === 'note' && entity.beat >= slide && entity.beat < slide + 20,
                ),
            })
            await nextTick()
        }, slide)
    await page.evaluate(async () => {
        const { history, nextTick, fixtures } = window.editorTest
        // A short range on one slide, a long one on the other.
        const chart = structuredClone(fixtures.interaction)
        const [head] = chart.slides[0]!
        chart.slides = [
            [
                { ...head!, beat: 1 },
                { ...head!, beat: 2 },
            ],
            [
                { ...head!, beat: 56 + 1 / 3 },
                { ...head!, beat: 62.75 },
            ],
        ]
        history.resetState(false, chart, 0, { sourceName: 'stacking.json' })
        await nextTick()
    })
    await select(0)
    const beat = field(page, 'Temps')
    await expect(beat.locator('input')).toHaveAttribute('placeholder', '2 … 3')
    await expect(beat).not.toHaveClass(/form-field-value-stacked/)
    // The same field, so only an update can refit it.
    await beat.evaluate((element) => (element.dataset.kept = ''))
    await select(50)
    await expect(beat.locator('input')).toHaveAttribute('placeholder', '57.3333 … 63.75')
    await expect(beat).toHaveAttribute('data-kept', '')
    await expect(beat).toHaveClass(/form-field-value-stacked/)
})

test('a label too long to sit beside its value stacks from the first selection through coverage and value changes', async ({
    page,
}) => {
    await open(page, 'en', 260, true)
    const presentation = field(page, 'Presentation')
    // Fitting sets the label's wrapping only while it measures; the last resort comes back.
    const label = () =>
        presentation.locator('.form-field-text').evaluate((text) => ({
            inline: text.style.overflowWrap,
            computed: getComputedStyle(text).overflowWrap,
            lines: Math.round(
                text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight),
            ),
        }))
    const line = () =>
        presentation.evaluate((field) =>
            field.querySelector('.form-field-inline')
                ? 'coverage'
                : field.querySelector('.form-field-mixed')
                  ? 'values'
                  : 'none',
        )
    // "Presentation" does not fit beside its value at 260 px, whatever line it has.
    const expectStacked = async (shown: string) => {
        await expect.poll(line).toBe(shown)
        await expect(presentation).toHaveClass(/form-field-value-stacked/)
        await expect.poll(label).toEqual({ inline: '', computed: 'anywhere', lines: 1 })
    }
    const select = (filter: 'coverage' | 'values' | 'none') =>
        page.evaluate(async (filter) => {
            const { history, store, nextTick } = window.editorTest
            const notes = [...store.getAllEntities()].filter((entity) => entity.type === 'note')
            const heads = notes.filter(
                (note) =>
                    !notes.some(
                        (other) => other.slideId === note.slideId && other.beat < note.beat,
                    ),
            )
            const chosen = {
                // Every note but the Fullscreen head: Default on 3 of 7.
                coverage: notes.filter((note) => note.connectorPresentation !== 'fullscreen'),
                // Every note: Default and Fullscreen, on 4 of 8.
                values: notes,
                // The Default heads only.
                none: heads.filter((note) => note.connectorPresentation === 'default'),
            }[filter]
            history.replaceState({ ...history.state.value, selectedEntities: chosen })
            await nextTick()
        }, filter)
    // The first selection shows every note, with mixed values.
    await expectStacked('values')
    for (const shown of ['coverage', 'values', 'none', 'coverage', 'none', 'values'] as const) {
        await select(shown)
        await expectStacked(shown)
    }
})

// Every field's layout in the Selection section: stacked, or beside its value with its coverage
// beside the label or under it.
const layout = (page: Page) =>
    selection(page)
        .locator('.form-field')
        .evaluateAll((fields) =>
            fields.map((field) => [
                field.querySelector('.form-field-text')?.textContent?.trim(),
                field.classList.contains('form-field-value-stacked')
                    ? 'stacked'
                    : field
                            .querySelector('.form-field-inline')
                            ?.classList.contains('form-field-stacked')
                      ? 'coverage under'
                      : 'beside',
            ]),
        )
const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        for (let i = 0; i < 4; i++) await new Promise((resolve) => requestAnimationFrame(resolve))
    })
const selectAll = (page: Page) =>
    page.evaluate(async () => {
        const { history, store, nextTick } = window.editorTest
        history.replaceState({ ...history.state.value, selectedEntities: [] })
        await nextTick()
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...store.getAllEntities()],
        })
        await nextTick()
    })

for (const [from, to] of [
    [260, 380],
    [380, 260],
] as const)
    test(`connectors selected at a ${from} px dock and kept at ${to} px lay out as if selected there`, async ({
        page,
    }) => {
        await page.addInitScript(installCanvasCounters)
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await page.evaluate(async (from) => {
            const { nextTick, fixtures, settings, show } = window.editorTest
            Object.assign(settings, {
                locale: 'en',
                showSidebar: true,
                rightDockWidth: from,
                propertiesConnectorExpanded: true,
            })
            show(fixtures.connectors, 3)
            await nextTick()
        }, from)
        await selectAll(page)
        await settle(page)
        await page.evaluate((to) => (window.editorTest.settings.rightDockWidth = to), to)
        await settle(page)
        const kept = await layout(page)
        await selectAll(page)
        await settle(page)
        expect(kept).toEqual(await layout(page))
    })
