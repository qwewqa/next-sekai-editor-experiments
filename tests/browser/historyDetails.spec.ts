import { expect, test, type Locator, type Page } from '@playwright/test'
import { errorsFail, load, noErrors } from './historyJourney'

/*
 * Step Details as drawn (proposal section 6): the record table, the minimal form, before then after,
 * a group's steps, the state in the meta line and the phone card. Real input where a producer makes
 * the entry; the operation is handed to the dialog directly where only the dialog is under test.
 */

type Spec = { input: unknown; time?: number; kind?: 'edit' | 'undo' | 'redo' }
type Flags = { removed: boolean; damaged: boolean }
type Options = {
    time?: number
    flags?: Flags
    /** Flags of members by index, oldest first. */
    memberFlags?: Record<number, Flags>
    /** An undo or redo parent, whose members are crossed steps. */
    direction?: 'undo' | 'redo'
}

// Built in UTC and drawn in UTC, so the times read the same in any zone the tests run in.
const T0 = Date.UTC(new Date().getUTCFullYear(), 9, 19, 5, 34, 56)
test.use({ timezoneId: 'UTC' })
const details = (page: Page) => page.locator('dialog[open]')

const openDetails = async (page: Page, specs: Spec[], options: Options = {}) => {
    await page.evaluate(
        async ({ specs, options, T0 }) => {
            const { appImport, historySteps } = window.editorTest
            const [{ openOperationDetails }, { captureOperationRecipe }, operations] =
                await Promise.all([
                    appImport<typeof import('../../src/editor/history/operationDetails')>(
                        '/src/editor/history/operationDetails.ts',
                    ),
                    appImport<typeof import('../../src/history/operationPresentation')>(
                        '/src/history/operationPresentation/index.ts',
                    ),
                    appImport<typeof import('../../src/history/operations')>(
                        '/src/history/operations/index.ts',
                    ),
                ])
            void operations
            const members = specs.map((spec, i) => ({
                description: {
                    kind: spec.kind ?? 'edit',
                    step: historySteps.editStep(
                        historySteps.nativeOperation(spec.input as never, 'fixture'),
                    ),
                } as never,
                time: spec.time ?? T0 - (specs.length - 1 - i) * 7000,
                id: `m${i}`,
            }))
            const memberFlags = new Map(
                Object.entries(options.memberFlags ?? {}).map(([index, flags]) => [
                    `m${index}`,
                    flags,
                ]),
            )
            void openOperationDetails(
                captureOperationRecipe(
                    members,
                    options.direction ? { direction: options.direction } : undefined,
                ),
                options.time ?? T0,
                undefined,
                undefined,
                { row: options.flags, members: memberFlags },
            )
        },
        { specs, options, T0 },
    )
    await expect(details(page)).toBeVisible()
}

const op = (id: string, data: unknown): Spec => ({ input: { id, data } })
const root = (page: Page) => details(page).locator('[data-operation-details]').first()
const text = async (locator: ReturnType<Page['locator']>) =>
    ((await locator.textContent()) ?? '').replace(/\s+/g, ' ').trim()

test.beforeEach(async ({ page }) => {
    errorsFail(page)
    await load(page)
})
test.afterEach(({ page }) => noErrors(page))

test('a title that says everything shows the minimal form: the title and the meta line', async ({
    page,
}) => {
    await openDetails(page, [op('nse.note.add', { created: 5 })])
    await expect(root(page).locator('[data-operation-description]')).toHaveText('Added 5 notes')
    await expect(root(page).locator('[data-operation-time]')).toHaveText(/^Oct 19, 5:34:56 AM$/)
    await expect(root(page).locator('[data-operation-record], h3, dl, ul')).toHaveCount(0)
    // The header is the only block.
    await expect(root(page).locator(':scope > *')).toHaveCount(1)
})

const RECORDS: [string, Spec][] = [
    ['note add', op('nse.note.add', { created: 3 })],
    ['object add', op('nse.object.add', { subject: 'timeScale', created: 2 })],
    ['bpm move', op('nse.object.move', { subject: 'bpm', changed: { bpm: 1 } })],
    [
        'mixed move',
        op('nse.object.move', {
            subject: 'objects',
            changed: { note: 6, bpm: 2, cameraEvent: 1 },
            displaced: { bpm: 2 },
            retainedInitialBpm: true,
        }),
    ],
    ['empty changes', op('nse.object.edit', { subject: 'note', changed: {} })],
    [
        'paste',
        op('nse.object.paste', {
            placed: { note: 3, bpm: 1, timeScale: 2 },
            displaced: { bpm: 1, timeScale: 1 },
            variant: 'composed',
            flipped: true,
            at: 'position',
        }),
    ],
    [
        'property set',
        op('nse.property.set', {
            subject: 'note',
            changed: { note: 2 },
            assignments: [
                {
                    field: 'left',
                    before: { mode: 'varying' },
                    after: { mode: 'uniform', value: 3 },
                },
            ],
        }),
    ],
    ['delete', op('nse.object.delete', { removed: { note: 3, bpm: 1 } })],
    [
        'flip',
        op('nse.object.flip', {
            axis: 'vertical',
            subject: 'objects',
            changed: { note: 2, bpm: 1 },
            displaced: { note: 1 },
        }),
    ],
    ['initial life', op('nse.header.set', { field: 'initialLife', before: 1000, after: 900 })],
    [
        'bgm',
        op('nse.bgm.change', {
            file: { before: { text: 'old.mp3' }, after: { text: 'new.mp3' } },
            offset: { before: -0.5, after: 0.25 },
        }),
    ],
    ['bgm removed', op('nse.bgm.change', { file: { before: { text: 'old.mp3' }, after: null } })],
    [
        'owner move',
        op('nse.owner.move', {
            target: { kind: 'group', id: 3, name: { text: 'Alpha' } },
            destination: null,
            category: 'reorder',
            fromIndex: 2,
            toIndex: 0,
        }),
    ],
    [
        'owner delete',
        op('nse.owner.delete', {
            domain: 'group',
            removed: { group: 1 },
            target: { kind: 'group', id: 3, name: { text: 'Alpha' } },
            objects: { note: 800, timeScale: 12 },
            replacement: { kind: 'group', id: 4, name: { text: 'Group 1' } },
        }),
    ],
    [
        'owner set',
        op('nse.owner.set', {
            target: { kind: 'group', id: 3, name: { text: 'Alpha' } },
            changes: [{ field: 'forceNoteSpeed', before: null, after: 1.5 }],
        }),
    ],
    ['continue', op('nse.continue', { fromTime: T0 - 86_400_000 })],
    ['recovery', op('nse.recovery', { droppedSteps: 0 })],
    ['external', op('nse.externalChange', {})],
]

for (const [name, spec] of RECORDS)
    test(`${name}: no empty block, no zero, no internal id and no title repeated`, async ({
        page,
    }) => {
        await openDetails(page, [spec])
        const body = root(page)
        const title = await text(body.locator('[data-operation-description]'))
        expect(title).not.toBe('')
        // Every heading, label and value has text; no heading stands over nothing.
        for (const element of await body.locator('h3, dt, dd, li').all())
            expect(await text(element)).not.toBe('')
        for (const heading of await body.locator('h3').all())
            expect(
                await heading.evaluate((h) => {
                    const next = h.nextElementSibling
                    return !!next && (next.textContent ?? '').trim() !== ''
                }),
            ).toBe(true)
        // A label never equals its value, another label or the title, and a row never restates the
        // title.
        const labels = await body.locator('dt').allTextContents()
        expect(new Set(labels).size).toBe(labels.length)
        for (const row of await body.locator('[data-operation-field]').all()) {
            const label = await text(row.locator('dt'))
            const value = await text(row.locator('dd'))
            expect(value).not.toBe(label)
            expect(value).not.toBe(title)
        }
        for (const fact of await body.locator('[data-operation-fact]').all())
            expect(await text(fact)).not.toBe(title)
        const all = await text(body)
        expect(all).not.toMatch(/#\d/)
        expect(all).not.toContain('Not present')
        // No count phrase of zero.
        for (const item of await body.locator('dd li').allTextContents())
            expect(item).not.toMatch(/^0\s/)
    })

test('a change reads before, then after, with the chevron between and screen-reader words', async ({
    page,
}) => {
    await openDetails(page, [
        op('nse.property.set', {
            subject: 'note',
            changed: { note: 2 },
            assignments: [
                {
                    field: 'left',
                    before: { mode: 'uniform', value: 2 },
                    after: { mode: 'uniform', value: 3 },
                },
            ],
        }),
    ])
    const row = root(page).locator('[data-operation-field]').first()
    await expect(row.locator('dt')).toHaveText('Lane')
    expect(await text(row.locator('dd'))).toBe('Before 2 After 3')
    const order = await row.locator('dd').evaluate((dd) => {
        const before = [...dd.querySelectorAll('span')].find((s) => s.textContent === '2')!
        const after = [...dd.querySelectorAll('span')].find((s) => s.textContent === '3')!
        const chevron = dd.querySelector('svg')!
        return [before, chevron, after].map((e) => e.getBoundingClientRect().left)
    })
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(new Set(order).size).toBe(3)
})

test('a placeholder is drawn quieter than a value', async ({ page }) => {
    await openDetails(page, [
        op('nse.property.set', {
            subject: 'note',
            changed: { note: 2 },
            assignments: [
                {
                    field: 'left',
                    before: { mode: 'varying' },
                    after: { mode: 'uniform', value: 3 },
                },
            ],
        }),
    ])
    const dd = root(page).locator('[data-operation-field] dd').first()
    await expect(dd.locator('span.text-fg\\/80')).toHaveText('Varies')
    await expect(dd.locator('span', { hasText: /^3$/ })).not.toHaveClass(/text-fg\/80/)
})

test('a group lists its steps newest first, with a count heading, and only a step with a record opens', async ({
    page,
}) => {
    // Three Lane edits: each step has a change row, so each opens.
    const lane = (before: number, after: number) =>
        op('nse.property.set', {
            subject: 'note',
            changed: { note: 2 },
            assignments: [
                {
                    field: 'left',
                    before: { mode: 'uniform', value: before },
                    after: { mode: 'uniform', value: after },
                },
            ],
        })
    await openDetails(page, [lane(0, 1), lane(1, 2), lane(2, 3)])
    const steps = details(page).locator('[data-operation-children]')
    await expect(steps.locator('h3')).toHaveText('3 steps')
    await expect(steps.locator('summary span.flex-1')).toHaveText([
        'Set Lane to 3 on 2 notes',
        'Set Lane to 2 on 2 notes',
        'Set Lane to 1 on 2 notes',
    ])
    await expect(steps.locator('summary > span:last-child')).toHaveText([
        '5:34:56 AM',
        '5:34:49 AM',
        '5:34:42 AM',
    ])
    await steps.locator('summary').first().click()
    const nested = steps.locator('[data-operation-details]')
    await expect(nested).toHaveCount(1)
    await expect(nested.locator('[data-operation-description], [data-operation-time]')).toHaveCount(
        0,
    )
    expect(await text(nested.locator('dd'))).toBe('Before 2 After 3')
    // The nested record sits under its step's own rule: no second rule at its top.
    expect(
        await nested
            .locator('dt, dd')
            .first()
            .evaluate((e) => getComputedStyle(e).borderTopWidth),
    ).toBe('0px')
})

test('steps without a record of their own are plain rows with no disclosure', async ({ page }) => {
    await openDetails(page, [
        op('nse.note.add', { created: 2 }),
        op('nse.note.add', { created: 2 }),
        op('nse.note.add', { created: 2 }),
    ])
    const steps = details(page).locator('[data-operation-children]')
    await expect(steps.locator('h3')).toHaveText('3 steps')
    await expect(steps.locator('summary, details')).toHaveCount(0)
    await expect(steps.locator('[data-operation-step]')).toHaveCount(3)
    // Plain rows are not in the tab order.
    await expect(steps.locator('[data-operation-step][tabindex="-1"]')).toHaveCount(3)
    // The labels align with the disclosure rows' labels: after a 12 px slot and an 8 px gap.
    const [first] = await steps
        .locator('[data-operation-step] > span.flex-1')
        .evaluateAll((spans) => spans.map((s) => s.getBoundingClientRect().left))
    const row = await steps
        .locator('[data-operation-step]')
        .first()
        .evaluate((r) => r.getBoundingClientRect().left)
    expect(first! - row).toBe(8 + 12 + 8)
})

test('the meta line says when a step was not kept or is damaged', async ({ page }) => {
    await openDetails(page, [op('nse.note.add', { created: 5 })], {
        flags: { removed: true, damaged: false },
    })
    await expect(root(page).locator('[data-operation-time]')).toHaveText(
        'Oct 19, 5:34:56 AM · not kept',
    )
    await page.keyboard.press('Escape')
    await expect(details(page)).toHaveCount(0)
    await openDetails(page, [op('nse.note.add', { created: 5 })], {
        flags: { removed: false, damaged: true },
    })
    await expect(root(page).locator('[data-operation-time]')).toHaveText(
        'Oct 19, 5:34:56 AM · damaged',
    )
    await page.keyboard.press('Escape')
    // An available step has no flag text.
    await openDetails(page, [op('nse.note.add', { created: 5 })], {
        flags: { removed: false, damaged: false },
    })
    await expect(root(page).locator('[data-operation-time]')).toHaveText('Oct 19, 5:34:56 AM')
})

test('a step of a group shows its own flag after its label', async ({ page }) => {
    await openDetails(
        page,
        [
            op('nse.note.add', { created: 2 }),
            op('nse.note.add', { created: 2 }),
            op('nse.note.add', { created: 2 }),
        ],
        { memberFlags: { 0: { removed: true, damaged: false } } },
    )
    const labels = details(page).locator('[data-operation-step] > span.flex-1')
    await expect(labels).toHaveText(['Added 2 notes', 'Added 2 notes', 'Added 2 notes · not kept'])
    await expect(labels.last().locator('span', { hasText: '·' })).toHaveClass(/text-fg\/80/)
})

test('a step shows its flag only when it differs from the group row’s', async ({ page }) => {
    const removed = { removed: true, damaged: false }
    const specs = [
        op('nse.note.add', { created: 2 }),
        op('nse.note.add', { created: 2 }),
        op('nse.note.add', { created: 2 }),
    ]
    // Every step of a removed group is removed too: the meta line says so once.
    await openDetails(page, specs, {
        flags: removed,
        memberFlags: { 0: removed, 1: removed, 2: removed },
    })
    await expect(root(page).locator('[data-operation-time]')).toHaveText(
        'Oct 19, 5:34:56 AM · not kept',
    )
    const labels = details(page).locator('[data-operation-step] > span.flex-1')
    await expect(labels).toHaveText(['Added 2 notes', 'Added 2 notes', 'Added 2 notes'])
    await page.keyboard.press('Escape')
    await expect(details(page)).toHaveCount(0)
    // A step that differs from the group row keeps its own flag.
    await openDetails(page, specs, {
        flags: removed,
        memberFlags: { 0: removed, 1: { removed: false, damaged: true }, 2: removed },
    })
    await expect(labels).toHaveText(['Added 2 notes', 'Added 2 notes · damaged', 'Added 2 notes'])
})

const laneStep = (before: number, after: number) =>
    op('nse.property.set', {
        subject: 'note',
        changed: { note: 2 },
        assignments: [
            {
                field: 'left',
                before: { mode: 'uniform', value: before },
                after: { mode: 'uniform', value: after },
            },
        ],
    })

test('every step row draws a straight rule: the rounded element carries no border', async ({
    page,
}) => {
    const rules = () =>
        details(page)
            .locator('[data-operation-children] > div > *')
            .evaluateAll((rows) =>
                rows.map((row) => {
                    const own = getComputedStyle(row)
                    const inner = getComputedStyle(row.firstElementChild!)
                    return {
                        rule: own.borderTopWidth,
                        radius: own.borderTopLeftRadius + own.borderTopRightRadius,
                        innerRule: inner.borderTopWidth,
                        innerRadius: inner.borderTopLeftRadius,
                    }
                }),
            )
    const straight = { rule: '1px', radius: '0px0px', innerRule: '0px', innerRadius: '8px' }
    // Rows with a record open: the rule is on the details, the radius on the summary.
    await openDetails(page, [laneStep(0, 1), laneStep(1, 2)])
    expect(await rules()).toEqual([straight, straight])
    await page.keyboard.press('Escape')
    await expect(details(page)).toHaveCount(0)
    // Plain rows are built the same way.
    await openDetails(page, [
        op('nse.note.add', { created: 2 }),
        op('nse.note.add', { created: 2 }),
    ])
    expect(await rules()).toEqual([straight, straight])
})

test('a chevron sits on the first line of wrapped content', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 })
    const long = 'A very long name that keeps going and going '.repeat(3)
    const speed = (before: number | null, after: number | null) =>
        op('nse.owner.set', {
            target: { kind: 'group', id: 3, name: { text: long } },
            changes: [{ field: 'forceNoteSpeed', before, after }],
        })
    // The centre of the glyph below the top of its row.
    const centre = async (glyph: Locator, row: Locator) => {
        const [g, r] = [(await glyph.boundingBox())!, (await row.boundingBox())!]
        return g.y + g.height / 2 - r.y
    }
    await openDetails(page, [speed(null, 1), speed(1, 2)])
    // The step's label wraps over several lines; its chevron stays beside the first: 8 px of
    // padding, then half of a 24 px line.
    const summary = details(page).locator('[data-operation-children] summary').first()
    expect((await summary.boundingBox())!.height).toBeGreaterThan(80)
    expect(await centre(summary.locator('svg'), summary)).toBeCloseTo(8 + 12, 0)
    await expect(summary.locator('svg')).toHaveClass(/text-fg\/70/)
    await page.keyboard.press('Escape')
    await expect(details(page)).toHaveCount(0)
    // The same for a change whose after value wraps.
    await openDetails(page, [
        op('nse.property.set', {
            subject: 'note',
            changed: { note: 2 },
            assignments: [
                {
                    field: 'groupId',
                    before: {
                        mode: 'uniform',
                        value: { kind: 'group', id: 1, name: { text: 'Old' } },
                    },
                    after: {
                        mode: 'uniform',
                        value: { kind: 'group', id: 3, name: { text: long } },
                    },
                },
            ],
        }),
    ])
    // The after value wraps below the before value; the chevron stays with the first line of it.
    const dd = details(page).locator('[data-operation-field] dd').first()
    const after = dd.locator('span.tabular-nums').last()
    expect((await after.boundingBox())!.height).toBeGreaterThan(70)
    expect(await centre(dd.locator('svg'), after)).toBeCloseTo(12, 0)
})

test('an undo or redo parent has no count heading, which its title already carries', async ({
    page,
}) => {
    const specs: Spec[] = [
        { ...op('nse.note.add', { created: 2 }), kind: 'undo' },
        { ...op('nse.note.add', { created: 3 }), kind: 'undo' },
    ]
    await openDetails(page, specs, { direction: 'undo' })
    await expect(root(page).locator('[data-operation-description]')).toHaveText('Undid 2 steps')
    const steps = details(page).locator('[data-operation-children]')
    await expect(steps.locator('[data-operation-step]')).toHaveCount(2)
    await expect(steps.locator('h3, [data-operation-count]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(details(page)).toHaveCount(0)
    // An edit group's title has no count, so its heading stays.
    await openDetails(page, [
        op('nse.note.add', { created: 2 }),
        op('nse.note.add', { created: 3 }),
    ])
    await expect(steps.locator('h3')).toHaveText('2 steps')
})

test('Earlier Actions is ruled like the steps list', async ({ page }) => {
    await page.evaluate(async () => {
        const { appImport, historySteps } = window.editorTest
        const [{ openOperationDetails }, { captureOperationRecipe }] = await Promise.all([
            appImport<typeof import('../../src/editor/history/operationDetails')>(
                '/src/editor/history/operationDetails.ts',
            ),
            appImport<typeof import('../../src/history/operationPresentation')>(
                '/src/history/operationPresentation/index.ts',
            ),
        ])
        const head = historySteps.editStep(
            historySteps.futureFixtureOperation('recovery-head', {}, 'Source metadata'),
        )
        const dropped = [1, 2].map((i) =>
            historySteps.editStep(
                historySteps.futureFixtureOperation(`context-${i}`, {}, `Earlier action ${i}`),
            ),
        )
        void openOperationDetails(
            captureOperationRecipe([
                {
                    description: {
                        kind: 'recovered',
                        operation: historySteps.nativeOperation(
                            { id: 'nse.recovery', data: { droppedSteps: 2 } },
                            'Recovered',
                        ),
                        recoveryContext: { head, headIndex: 1, dropped, omitted: 0 },
                    },
                },
            ]),
            1234,
        )
    })
    await expect(details(page)).toBeVisible()
    const rows = await details(page)
        .locator('[data-operation-recovery] li')
        .evaluateAll((items) =>
            items.map((item) => {
                const own = getComputedStyle(item)
                const inner = getComputedStyle(item.firstElementChild!)
                return {
                    rule: own.borderTopWidth,
                    radius: own.borderTopLeftRadius,
                    innerRule: inner.borderTopWidth,
                    innerRadius: inner.borderTopLeftRadius,
                    padding: `${inner.paddingTop} ${inner.paddingLeft}`,
                }
            }),
        )
    expect(rows).toHaveLength(3)
    for (const row of rows)
        expect(row).toEqual({
            rule: '1px',
            radius: '0px',
            innerRule: '0px',
            innerRadius: '8px',
            padding: '8px 8px',
        })
})

test('an unreadable step shows its title and one note', async ({ page }) => {
    await page.evaluate(async () => {
        const { appImport, historySteps } = window.editorTest
        const [{ openOperationDetails }, { captureOperationRecipe }] = await Promise.all([
            appImport<typeof import('../../src/editor/history/operationDetails')>(
                '/src/editor/history/operationDetails.ts',
            ),
            appImport<typeof import('../../src/history/operationPresentation')>(
                '/src/history/operationPresentation/index.ts',
            ),
        ])
        void openOperationDetails(
            captureOperationRecipe([
                {
                    description: {
                        kind: 'export',
                        operation: historySteps.futureFixtureOperation(
                            'future-export',
                            { futureParameter: 9 },
                            '<b>Future export</b>',
                        ),
                    },
                },
            ]),
            1234,
        )
    })
    await expect(root(page).locator('[data-operation-description]')).toHaveText(
        '<b>Future export</b>',
    )
    await expect(root(page).locator('[data-operation-unsupported]')).toHaveText(
        'This version of the editor cannot read the details of this step.',
    )
    await expect(root(page).locator('[data-operation-record], h3')).toHaveCount(0)
})

test('Details opens focused at its top and Escape closes it', async ({ page }) => {
    await openDetails(page, [
        op('nse.object.paste', {
            placed: { note: 3 },
            variant: 'basic',
            flipped: false,
            at: 'pointer',
        }),
    ])
    await expect(root(page)).toBeFocused()
    const top = await details(page)
        .locator('[data-operation-details]')
        .first()
        .evaluate((e) => e.parentElement!.scrollTop)
    expect(top).toBe(0)
    await page.keyboard.press('Tab')
    // Only the close button is a tab stop in a record with no disclosure.
    await expect(details(page).getByRole('button', { name: 'Close' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(details(page)).toHaveCount(0)
})

test('Show More reveals twenty more steps and moves focus to the first new one', async ({
    page,
}) => {
    const lane = (i: number) =>
        op('nse.property.set', {
            subject: 'note',
            changed: { note: 1 },
            assignments: [
                {
                    field: 'left',
                    before: { mode: 'uniform', value: i },
                    after: { mode: 'uniform', value: i + 1 },
                },
            ],
        })
    await openDetails(
        page,
        Array.from({ length: 45 }, (_, i) => lane(i)),
    )
    const steps = details(page).locator('[data-operation-children]')
    await expect(steps.locator('summary')).toHaveCount(20)
    await steps.getByRole('button', { name: 'Show More', exact: true }).click()
    await expect(steps.locator('summary')).toHaveCount(40)
    await steps.getByRole('button', { name: 'Show More', exact: true }).click()
    await expect(steps.locator('summary')).toHaveCount(45)
    await expect(steps.locator('summary').nth(40)).toBeFocused()
    await expect(steps.getByRole('button', { name: 'Show More' })).toHaveCount(0)
})

test('the close button comes first in the tab order, then each opened step, then Show More', async ({
    page,
}) => {
    const lane = (i: number) =>
        op('nse.property.set', {
            subject: 'note',
            changed: { note: 1 },
            assignments: [
                {
                    field: 'left',
                    before: { mode: 'uniform', value: i },
                    after: { mode: 'uniform', value: i + 1 },
                },
            ],
        })
    await openDetails(
        page,
        Array.from({ length: 22 }, (_, i) => lane(i)),
    )
    await expect(root(page)).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(details(page).getByRole('button', { name: 'Close' })).toBeFocused()
    const summaries = details(page).locator('summary')
    for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab')
        await expect(summaries.nth(i)).toBeFocused()
    }
    await page.keyboard.press('Tab')
    await expect(
        details(page).getByRole('button', { name: 'Show More', exact: true }),
    ).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(details(page)).toHaveCount(0)
})

test('a very long name wraps whole in the title and the card does not overflow', async ({
    page,
}) => {
    await page.setViewportSize({ width: 320, height: 700 })
    const long = 'A very long name that keeps going and going '.repeat(8).slice(0, 255) + 'x'
    await openDetails(page, [
        op('nse.owner.rename', {
            target: { kind: 'group', id: 3, name: { text: long } },
            before: { text: long },
            after: { text: 'Short' },
        }),
    ])
    const title = root(page).locator('[data-operation-description]')
    await expect(title).toContainText(long.slice(0, 40))
    const fits = await details(page).evaluate((dialog) => ({
        sideways: dialog.scrollWidth > dialog.clientWidth,
        bodyWidthFits: [...dialog.querySelectorAll('p, dt, dd, li')].every(
            (e) => e.getBoundingClientRect().right <= dialog.getBoundingClientRect().right + 0.5,
        ),
    }))
    expect(fits).toEqual({ sideways: false, bodyWidthFits: true })
})

test.describe('the phone card', () => {
    for (const width of [390, 320])
        test(`${width} wide: a centred card sized to its content, with no sideways overflow`, async ({
            page,
        }) => {
            await page.setViewportSize({ width, height: 844 })
            await openDetails(page, [op('nse.note.add', { created: 5 })])
            const minimal = await details(page).evaluate((dialog) => {
                const box = dialog.getBoundingClientRect()
                return {
                    left: box.left,
                    right: window.innerWidth - box.right,
                    top: box.top,
                    bottom: window.innerHeight - box.bottom,
                    scrolls: dialog.scrollWidth > dialog.clientWidth,
                    height: box.height,
                }
            })
            expect(minimal.scrolls).toBe(false)
            expect(Math.abs(minimal.left - minimal.right)).toBeLessThanOrEqual(1)
            expect(minimal.left).toBeGreaterThanOrEqual(8)
            // Centred and short: well clear of both edges.
            expect(Math.abs(minimal.top - minimal.bottom)).toBeLessThanOrEqual(1)
            expect(minimal.height).toBeLessThan(200)
            await page.keyboard.press('Escape')
            await openDetails(page, [
                op('nse.object.paste', {
                    placed: { note: 3, bpm: 1, timeScale: 2 },
                    displaced: { bpm: 1, timeScale: 1 },
                    variant: 'composed',
                    flipped: true,
                    at: 'position',
                }),
            ])
            const full = await details(page).evaluate((dialog) => ({
                scrolls: dialog.scrollWidth > dialog.clientWidth,
                inside: document.documentElement.scrollWidth <= window.innerWidth,
            }))
            expect(full).toEqual({ scrolls: false, inside: true })
        })

    test('below 19 rem the label stacks over its value, at a large root size too', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.evaluate(() => (document.documentElement.style.fontSize = '20px'))
        await openDetails(page, [
            op('nse.object.paste', {
                placed: { note: 3 },
                variant: 'basic',
                flipped: false,
                at: 'pointer',
            }),
        ])
        // The dialog's body is 342 px of 20 px rem: 17 rem, under the 19 rem threshold.
        const stacked = await details(page)
            .locator('[data-operation-field]')
            .first()
            .evaluate((row) => {
                const dt = row.querySelector('dt')!.getBoundingClientRect()
                const dd = row.querySelector('dd')!.getBoundingClientRect()
                return dd.top >= dt.bottom - 1 && Math.abs(dd.left - dt.left) <= 1
            })
        expect(stacked).toBe(true)
        await page.keyboard.press('Escape')
        await page.evaluate(() => (document.documentElement.style.fontSize = ''))
        await page.setViewportSize({ width: 800, height: 600 })
        await openDetails(page, [
            op('nse.object.paste', {
                placed: { note: 3 },
                variant: 'basic',
                flipped: false,
                at: 'pointer',
            }),
        ])
        const columns = await details(page)
            .locator('[data-operation-field]')
            .first()
            .evaluate((row) => {
                const dt = row.querySelector('dt')!.getBoundingClientRect()
                const dd = row.querySelector('dd')!.getBoundingClientRect()
                return dd.left > dt.left && Math.abs(dd.top - dt.top) <= 12
            })
        expect(columns).toBe(true)
    })
})

for (const [locale, title] of [
    ['fr', 'Détails de l’étape'],
    ['ja', '操作の詳細'],
] as const)
    test(`${locale}: long labels and values wrap inside the card on a phone`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.evaluate((locale) => {
            window.editorTest.settings.locale = locale
        }, locale)
        await openDetails(page, [
            op('nse.object.paste', {
                placed: { note: 3, bpm: 1, timeScale: 2 },
                displaced: { bpm: 1, timeScale: 1 },
                variant: 'composed',
                flipped: true,
                at: 'position',
            }),
        ])
        await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible()
        const fits = await details(page).evaluate((dialog) => {
            return [...dialog.querySelectorAll('dt, dd, li, p')].every(
                (e) =>
                    e.getBoundingClientRect().right <= dialog.getBoundingClientRect().right + 0.5,
            )
        })
        expect(fits).toBe(true)
    })
