import { expect, test, type Browser, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readNxsp } from '../../../src/local/nxsp'
import { ZipReader } from '../../../src/zip'
import { Editor } from '../../samples/driver'
import { closePage } from '../editorFixture'
import { errorsFail, noErrors, openHistory, timeline } from '../historyJourney'
import { readFile, writeFile } from '../saveFlows'
import { skipWhereTheEditorCannotStart } from '../webkitSupport'
import {
    afterDump,
    BLOB_STORES,
    chainsOf,
    prefix,
    readFixture,
    rowsOf,
    seededContext,
    storageKeys,
    valuesOf,
    visit,
    webDir,
    withOrphanChunk,
    withoutNewerData,
    type DumpJson,
} from './seed'

// The v1 web storage fixtures (tests/fixtures/web-storage-v1/) read by the
// running editor: a fresh profile seeded from a dump, the editor loaded over it, as it is when a
// maintainer loads a user's dump or a later build meets a profile v1 wrote. Each test names the
// bug it catches. WebKit's private contexts refuse Blobs, so the Blob stores are left out of the
// seed there and the checks that need them are skipped. The Save that writes a file needs the
// Chromium override's pickers.

// A WebKit build without OffscreenCanvas (Playwright's on Windows) cannot start the editor.
skipWhereTheEditorCannotStart()

const main = readFixture('nse-local-data.json')
const chains = chainsOf(main)

const profile = async (
    browser: Browser,
    browserName: string,
    {
        days = 1,
        dump = main,
        files,
        zip,
    }: { days?: number; dump?: DumpJson; files?: 'opfs' | 'download'; zip?: Uint8Array } = {},
) =>
    seededContext(browser, dump, {
        start: afterDump(dump, days),
        files: files ?? (browserName === 'chromium' ? 'opfs' : 'download'),
        without: browserName === 'webkit' ? BLOB_STORES : [],
        zip,
    })

const row = (page: Page, chainId: string) =>
    page.locator(`[data-sessions-row][data-chain="${chainId}"]`)

const openRecent = async (page: Page) => {
    // A Restore leaves History open on the Timeline: a second press of its key would close it.
    if (!(await page.locator('[data-history-list]').count())) await openHistory(page)
    await page.getByRole('tab', { name: 'Recent Sessions' }).click()
    await expect(page.locator('[data-recent-sessions]')).toBeVisible()
    await expect(page.locator('[data-sessions-loading]')).toHaveCount(0)
}

/** A row's ⋯ menu item. */
const rowAction = async (page: Page, chainId: string, item: string) => {
    await row(page, chainId).locator('[data-sessions-more]').click()
    await page.getByRole('menu').getByRole('menuitem', { name: item, exact: true }).click()
}

const notices = (page: Page) =>
    page.evaluate(() =>
        [...document.querySelectorAll('.notification, .notification-pill, [data-notice-card]')].map(
            (element) => (element as HTMLElement).innerText.replace(/\s+/g, ' '),
        ),
    )

/** A note at a beat nothing is near, through the Note tool: one entry. */
const edit = async (page: Page, beat = 3000) => {
    const editor = new Editor(page)
    await editor.ready()
    // The Note tool: its key cycles presets once it is selected, so it is pressed until it is.
    await expect
        .poll(async () => {
            const tool = () =>
                page.evaluate(
                    async () => (await import('/src/editor/tools/index.ts')).toolName.value,
                )
            if ((await tool()) !== 'note') await editor.command('a')
            return tool()
        })
        .toBe('note')
    await editor.focus(beat)
    await expect.poll(() => editor.act(() => editor.click(0, beat))).toBeTruthy()
    await editor.settled()
    return editor
}

const chainRows = async (page: Page) =>
    ((await rowsOf(page, ['chains'])).chains ?? []).map((each) => each.value)

test('the pending journal applies as a recovered entry, and the saving marker is read as written', async ({
    browser,
    browserName,
}) => {
    // Catches a later build whose journal reader rejects a v1 journal (the last edits lost, or a
    // recovery chain made in place of the session), and one that ignores or drops a v1 `saving.*`
    // marker (the Save's binding lost when the file was written and the page died).
    const { context, clock } = await profile(browser, browserName)
    const page = await visit(context, clock)
    const journal = Object.keys(main.localStorage).find((key) =>
        key.startsWith(`${prefix}journal.`),
    )!
    const sessionId = journal.slice(`${prefix}journal.`.length)
    const before = valuesOf(main, 'entries').filter((entry) => entry.sessionId === sessionId)
    const after = (await rowsOf(page, ['entries']))
        .entries!.map((each) => each.value)
        .filter((entry) => entry.sessionId === sessionId)
        .sort((a, b) => (a.seq as number) - (b.seq as number))
    // The journal became one more entry of its own session (a recovery chain would be another session).
    expect(after.length).toBe(before.length + 1)
    expect(after.at(-1)).toMatchObject({
        kind: 'recovered',
        seq: JSON.parse(main.localStorage[journal]!).seq,
    })
    const keys = await storageKeys(page)
    expect(keys.filter((key) => key.startsWith('journal.'))).toEqual([])
    // The marker stays, and reads as the write it describes.
    const marker = keys.find((key) => key.startsWith('saving.'))!
    expect(marker).toBe(`saving.${chains.A}`)
    const read = await page.evaluate(async (chainId) => {
        const { readMarker, markedSeq } = await import('/src/editor/save/env.ts')
        const marker = readMarker(chainId)
        return (
            marker && {
                revisionId: marker.entry.revisionId,
                seq: marker.entry.seq,
                session: marker.entry.sessionId,
                seen: markedSeq(marker.entry.sessionId),
            }
        )
    }, chains.A)
    const text = JSON.parse(main.localStorage[`${prefix}${marker}`]!) as {
        entry: { revisionId: string; seq: number; sessionId: string }
    }
    expect(read).toEqual({
        revisionId: text.entry.revisionId,
        seq: text.entry.seq,
        session: text.entry.sessionId,
        seen: text.entry.seq,
    })
    // A continues, under its file's name.
    expect(await page.evaluate(() => window.nseFlushTest!.flusher.session?.chainId)).toBe(chains.A)
    await expect(page.locator('[data-status-label]')).toContainText('fixture.nxsp')
    await context.close()
})

test('a Save whose file was written but whose binding was not recorded is recognised as our own', async ({
    browser,
    browserName,
}) => {
    test.skip(browserName !== 'chromium', 'The write-back uses Chromium’s pickers')
    // Catches a later build that no longer recognises a v1 `saving.*` marker: the next Save would
    // find its own earlier write changed on disk and offer a conflict, or write over it.
    const markerFile = new Uint8Array(readFileSync(join(webDir, 'saving-marker-file.nxsp')))
    const marker = await readNxsp(new Blob([markerFile]))
    if (marker.kind !== 'nxsp') throw new Error('The marker file does not open')
    const markerRevision = marker.projectJson.revision as { id: string; n: number }
    // A's file handle is not in a dump; the override's token stands for it, as in a real profile.
    const name = 'fixture.nxsp'
    const dump: DumpJson = {
        ...main,
        stores: main.stores.map((store) =>
            store.name === 'handles'
                ? {
                      ...store,
                      records: store.records.map((record) =>
                          record.value.chainId === chains.A && record.value.role === 'file'
                              ? {
                                    ...record,
                                    value: { ...record.value, handle: { testHandle: name } },
                                }
                              : record,
                      ),
                  }
                : store,
        ),
    }
    const { context, clock } = await profile(browser, browserName, { dump, files: 'opfs' })
    const page = await visit(context, clock)
    await writeFile(page, name, markerFile)
    expect((await storageKeys(page)).some((key) => key === `saving.${chains.A}`)).toBe(true)
    await edit(page)
    await page.locator('canvas.editor-chart').focus()
    await page.keyboard.press('p')
    await expect
        .poll(async () => (await storageKeys(page)).includes(`saving.${chains.A}`), {
            timeout: 30_000,
        })
        .toBe(false)
    // The Save then writes on top of the marker's file.
    await expect
        .poll(
            async () => {
                const bytes = await readFile(page, name)
                const now = bytes && (await readNxsp(new Blob([new Uint8Array(bytes)])))
                return now && now.kind === 'nxsp'
                    ? (now.projectJson.revision as { n: number }).n
                    : 0
            },
            { timeout: 30_000 },
        )
        .toBeGreaterThan(markerRevision.n)
    // No conflict was offered, and the file is the marker's write plus this Save.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const after = await readNxsp(new Blob([new Uint8Array((await readFile(page, name))!)]))
    expect(after.kind).toBe('nxsp')
    if (after.kind !== 'nxsp') return
    expect(after.open).toBe('full')
    expect((after.projectJson.revision as { parent: string }).parent).toBe(markerRevision.id)
    expect((after.projectJson.revision as { n: number }).n).toBeGreaterThan(markerRevision.n)
    await context.close()
})

test('Recent Sessions lists M, A, F, I, P and Q once each, and not the deleted N', async ({
    browser,
    browserName,
}) => {
    // Catches a later build that lists a chain twice or not at all, or lets the `deleting` mark of
    // a v1 chain go unread (a deleted chain coming back).
    const { context, clock } = await profile(browser, browserName)
    const page = await visit(context, clock)
    await openRecent(page)
    const listed = await page
        .locator('[data-sessions-row]')
        .evaluateAll((rows) => rows.map((each) => each.getAttribute('data-chain')))
    expect(listed.sort()).toEqual(
        [chains.M, chains.A, chains.F, chains.I, chains.P, chains.Q].sort(),
    )
    expect(listed).not.toContain(chains.N)
    await expect(row(page, chains.A)).toHaveAttribute('data-badge', 'thisTab')
    await context.close()
})

/** Scrolls the open Timeline to its start, collecting what its rows and dividers say. */
const readTimeline = async (page: Page, until: (seen: Seen) => boolean) => {
    const list = timeline(page)
    const box = (await list.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const seen: Seen = { labels: new Set(), dividers: new Set(), flags: new Set(), ended: false }
    for (let i = 0; i < 800 && !until(seen); i++) {
        for (const text of await list
            .locator('[data-history-row]')
            .evaluateAll((rows) => rows.map((each) => each.getAttribute('aria-label') ?? '')))
            seen.labels.add(text)
        for (const text of await list.locator('[data-history-continuation]').allInnerTexts())
            seen.dividers.add(text.replace(/\s+/g, ' '))
        for (const text of await list.locator('[data-history-flag]').allInnerTexts())
            seen.flags.add(text.replace(/\s+/g, ' '))
        seen.ended = (await list.locator('[data-history-end]').count()) > 0
        await page.mouse.wheel(0, 500)
        await page.waitForTimeout(10)
    }
    return seen
}

type Seen = { labels: Set<string>; dividers: Set<string>; flags: Set<string>; ended: boolean }

test('A’s Timeline shows its dividers, the recovered entry and the damaged row, and Undo walks the stored stack to a BGM cleanup removed', async ({
    browser,
    browserName,
}) => {
    test.setTimeout(180_000)
    // Catches v1 rows, stack blocks or `badChunks` misread (a wrong Timeline, Undo failing), and a
    // missing media row read as damage in place of "not loaded".
    const { context, clock } = await profile(browser, browserName)
    const page = await visit(context, clock)
    errorsFail(page)
    await openHistory(page)
    const seen = await readTimeline(
        page,
        (each) =>
            each.dividers.size >= 6 && [...each.labels].some((label) => label.includes('Exported')),
    )
    expect(seen.dividers.size).toBeGreaterThanOrEqual(6)
    expect([...seen.dividers].every((text) => text.startsWith('Continued from'))).toBe(true)
    expect(
        [...seen.labels].filter((label) => label.startsWith('Recovered changes')).length,
    ).toBeGreaterThanOrEqual(1)
    expect([...seen.labels].some((label) => label.includes(', damaged,'))).toBe(true)
    expect(
        [...seen.labels].filter((label) => label.startsWith('Saved fixture.nxsp')).length,
    ).toBeGreaterThanOrEqual(2)
    await page.keyboard.press('Escape')

    // Undo walks the stored stack. The BGM step the cleanup left unheld (the first song, kept only
    // by earlier steps) reads "not loaded" with Choose Audio…, never as damage.
    const editor = new Editor(page)
    await editor.ready()
    let undone = 0
    const card = page.locator('[data-notice-card]').filter({ hasText: 'The BGM is not loaded.' })
    for (; undone < 40; undone++) {
        await expect.poll(() => editor.act(() => editor.command('z'), 4000)).toBeTruthy()
        const unheld = await page.evaluate(async () => {
            const { liveState } = await import('/src/history/stack.ts')
            return (
                liveState.value.bgm.meta !== undefined && liveState.value.bgm.buffer === undefined
            )
        })
        if (unheld) break
    }
    expect(undone).toBeLessThan(40)
    await expect(card).toHaveCount(1)
    await expect(card.getByRole('button', { name: 'Choose Audio…' })).toBeVisible()
    expect(
        await page.evaluate(async () => {
            const { liveState } = await import('/src/history/stack.ts')
            return {
                hash: liveState.value.bgm.meta?.hash,
                decoded: liveState.value.bgm.buffer !== undefined,
            }
        }),
    ).toMatchObject({ decoded: false })
    noErrors(page)
    await context.close()
})

test('Restore Session of M and of I opens each as it was', async ({ browser, browserName }) => {
    // Catches a later build that cannot restore a v1 chain made by the old auto save's migration or
    // by an import (their sessions' origins `migrated` and `import`).
    const { context, clock } = await profile(browser, browserName)
    const page = await visit(context, clock)
    await openRecent(page)
    await rowAction(page, chains.M, 'Restore Session')
    await expect
        .poll(() => page.evaluate(() => window.nseFlushTest!.flusher.session?.chainId))
        .toBe(chains.M)
    // The old auto save's chart: one BPM change of 150.
    expect(
        await page.evaluate(async () => {
            const { liveState } = await import('/src/history/stack.ts')
            return liveState.value.bpms.map((bpm) => Math.round((60 / bpm.s) * 1000) / 1000)
        }),
    ).toEqual([150])
    await page.locator('[data-history-surface] [role=tab]').first().waitFor()
    await openRecent(page)
    await rowAction(page, chains.I, 'Restore Session')
    await expect
        .poll(() => page.evaluate(() => window.nseFlushTest!.flusher.session?.chainId))
        .toBe(chains.I)
    const summary = valuesOf(main, 'chains').find((chain) => chain.chainId === chains.I)!
        .summary as { noteCount: number }
    expect(
        await page.evaluate(async () => {
            const { liveState } = await import('/src/history/stack.ts')
            return [...liveState.value.store.slides.note.values()].flat().length
        }),
    ).toBe(summary.noteCount)
    await context.close()
})

test('Restore Session of Q settles its unfinished import and loses no row', async ({
    browser,
    browserName,
}) => {
    // Catches a later build that leaves a v1 chain with a pending import unreadable (a seeded profile
    // has no handle to resume it from), or marks rows lost that the store holds: Q is a copy of A's
    // file, so every state it names is already stored.
    const { context, clock } = await profile(browser, browserName)
    const page = await visit(context, clock)
    const before = valuesOf(main, 'entries').filter((entry) => entry.kept === false).length
    await openRecent(page)
    await rowAction(page, chains.Q, 'Restore Session')
    await expect
        .poll(() => page.evaluate(() => window.nseFlushTest!.flusher.session?.chainId))
        .toBe(chains.Q)
    await expect
        .poll(
            async () =>
                ((await rowsOf(page, ['sessions'])).sessions ?? []).filter(
                    (each) => each.value.importPending === true,
                ).length,
            { timeout: 30_000 },
        )
        .toBe(0)
    const rows = ((await rowsOf(page, ['entries'])).entries ?? []).map((each) => each.value)
    expect(rows.filter((entry) => entry.kept === false).length).toBe(before)
    await context.close()
})

test('N is swept and F’s Timeline then ends with the earlier steps not stored; GC past the grace period leaves every kept state readable', async ({
    browser,
    browserName,
}) => {
    test.setTimeout(240_000)
    // Catches the `deleting` mark ignored by the sweep (a deleted chain kept for good), and a later
    // GC that misses a v1 reference (a stack block's slot, a recovered entry's pushed state, a media
    // row, a node's child): silent loss of a state the Timeline still lists.
    // Without the newer-build data, which would stop a GC pass (it never deletes beside data it cannot
    // read), and with one body no row names, which only GC removes.
    const { dump, hash: orphan } = withOrphanChunk(withoutNewerData(main))
    const { context, clock } = await profile(browser, browserName, { days: 3, dump })
    const page = await visit(context, clock)
    const lastGc = (
        valuesOf(dump, 'meta').find((each) => each.key === 'lastGcAt')!.value as {
            time: number
            unsafe?: boolean
        }
    ).time
    const orphaned = () =>
        page.evaluate(async (hash) => {
            const { toHex } = await import('/src/local/hash.ts')
            const { chunks } = (await window.nseStorageTest!.worker.call('testRows', [
                'chunks',
            ])) as unknown as { chunks: { key: ArrayBuffer }[] }
            return chunks.some((each) => toHex(new Uint8Array(each.key)) === hash)
        }, orphan)
    expect(await orphaned()).toBe(true)
    // The sweep removes N and sets deletionsPending, and GC runs: a day of use, past the grace period.
    await expect
        .poll(
            async () =>
                ((await rowsOf(page, ['chains'])).chains ?? []).some(
                    (each) => each.value.chainId === chains.N,
                ),
            { timeout: 60_000 },
        )
        .toBe(false)
    await expect
        .poll(
            async () => {
                const meta = (await rowsOf(page, ['meta'])).meta!
                return (
                    meta.find((each) => each.key === 'lastGcAt')!.value as {
                        value: { time: number }
                    }
                ).value.time
            },
            { timeout: 60_000 },
        )
        .toBeGreaterThan(lastGc)
    // GC deleted what nothing names, and found nothing it could not read.
    await expect.poll(orphaned, { timeout: 30_000 }).toBe(false)
    const gc = (await rowsOf(page, ['meta'])).meta!.find((each) => each.key === 'lastGcAt')!
        .value as {
        value: { unsafe?: boolean }
    }
    expect(gc.value.unsafe).toBeUndefined()

    // Every kept row's state of every chain still reads, as do the stack's and a recovered entry's.
    const unreadable = await page.evaluate(async () => {
        const { toHex } = await import('/src/local/hash.ts')
        const stored = (await window.nseStorageTest!.worker.call('testRows', [
            'entries',
            'stackBlocks',
        ])) as unknown as {
            entries: {
                value: {
                    kept?: boolean
                    snapshot?: Uint8Array
                    stack?: { push: { snapshot: ArrayBuffer }[] }
                }
            }[]
            stackBlocks: { value: { hashes: Uint8Array } }[]
        }
        const roots = new Set<string>()
        for (const { value } of stored.entries) {
            if (value.kept !== false && value.snapshot)
                roots.add(toHex(new Uint8Array(value.snapshot)))
            for (const slot of value.stack?.push ?? [])
                roots.add(toHex(new Uint8Array(slot.snapshot)))
        }
        for (const { value } of stored.stackBlocks) {
            const bytes = new Uint8Array(value.hashes)
            for (let at = 0; at + 16 <= bytes.length; at += 16)
                roots.add(toHex(bytes.subarray(at, at + 16)))
        }
        const failed: string[] = []
        for (const root of roots) {
            try {
                await window.nseStorageTest!.worker.call('readSnapshot', root)
            } catch (error) {
                failed.push(`${root} ${String(error)}`)
            }
        }
        return { checked: roots.size, failed }
    })
    expect(unreadable.checked).toBeGreaterThan(100)
    // Only the state the writer damaged on purpose (the one marked not kept) fails to read.
    expect(unreadable.failed.length).toBeLessThanOrEqual(1)

    // F, a copy of N, has lost its parent: its Timeline says the earlier steps are not stored.
    await openRecent(page)
    await rowAction(page, chains.F, 'Restore Session')
    await expect(page.locator('[data-history-end]')).toContainText(
        'Earlier Timeline steps are not stored in this browser.',
    )
    await context.close()
})

test('a newer build’s data stays: continuing A, Restore as a Copy, a Save that opens fully', async ({
    browser,
    browserName,
}) => {
    test.setTimeout(120_000)
    // Catches a later build that drops fields it does not know on a v1 row (`zzFixtureChainField` on
    // a chain, `zzFixtureEntryField` on an entry), copies a field a fork must not take, writes an
    // unknown entry field into a file (the file would open partial), or loses an entry's `x`.
    const { context, clock } = await profile(browser, browserName)
    const page = await visit(context, clock)
    await edit(page)
    expect((await chainRows(page)).find((chain) => chain.chainId === chains.A)).toMatchObject({
        zzFixtureChainField: 'carried',
    })
    const rows = ((await rowsOf(page, ['entries'])).entries ?? []).map((each) => each.value)
    expect(rows.filter((entry) => entry.zzFixtureEntryField === 1)).toHaveLength(1)
    expect(
        rows.filter((entry) => (entry.x as { zzFixtureX?: number } | undefined)?.zzFixtureX === 1),
    ).toHaveLength(1)

    // Restore as a Copy, from a second tab that finds A open here.
    const second = await visit(context, clock)
    await openRecent(second)
    await expect(row(second, chains.A)).toHaveAttribute('data-badge', 'elsewhere')
    await rowAction(second, chains.A, 'Restore as a Copy')
    // A copy is stored with its first edit; History stays open after a Restore, over the chart.
    await second.keyboard.press('Escape')
    await edit(second, 3100)
    await expect
        .poll(
            async () =>
                (await chainRows(second)).filter((chain) => chain.zzFixtureChainField === 'carried')
                    .length,
        )
        .toBe(2)
    await second.close()

    // Save: A's file binding has no handle here, so the file is downloaded. Its entries have the `x`
    // and no unknown field.
    await page.bringToFront()
    const downloading = page.waitForEvent('download')
    await page.locator('canvas.editor-chart').focus()
    await page.keyboard.press('p')
    const bytes = new Uint8Array(readFileSync((await (await downloading).path())!))
    const read = await readNxsp(new Blob([new Uint8Array(bytes)]))
    if (read.kind !== 'nxsp' || !read.history) throw new Error('The Save wrote no history')
    expect(read.open).toBe('full')
    expect(read.report).toEqual([])
    expect(JSON.stringify(read.history.entries)).not.toContain('zzFixtureEntryField')
    expect(
        read.history.entries.filter(
            (entry) => (entry.x as { zzFixtureX?: number } | undefined)?.zzFixtureX === 1,
        ),
    ).toHaveLength(1)
    await context.close()
})

test('P needs a newer version: Restore Session says so, Save… is refused, its rows are untouched', async ({
    browser,
    browserName,
}) => {
    // Catches a later build that reads, restores or saves a chain whose newest session holds an entry
    // of a kind it does not know (a user's history written over or damaged by an older build).
    const { context, clock } = await profile(browser, browserName)
    const page = await visit(context, clock)
    const own = async () => {
        const stored = await rowsOf(page, ['sessions', 'entries'])
        return JSON.stringify([
            (stored.sessions ?? [])
                .filter((each) => each.value.chainId === chains.P)
                .map((each) => each.value),
            (stored.entries ?? [])
                .filter(
                    (each) =>
                        (each.value.kind as string) === 'zzFixtureKind' ||
                        [...(stored.sessions ?? [])].some(
                            (s) =>
                                s.value.chainId === chains.P && s.value.id === each.value.sessionId,
                        ),
                )
                .map((each) => each.value),
        ])
    }
    const before = await own()
    await openRecent(page)
    await rowAction(page, chains.P, 'Save…')
    await expect
        .poll(async () => (await notices(page)).some((text) => text.startsWith('Not saved')))
        .toBe(true)
    await rowAction(page, chains.P, 'Restore Session')
    await expect
        .poll(async () =>
            (await notices(page)).some((text) =>
                text.includes('needs a newer version of the editor'),
            ),
        )
        .toBe(true)
    expect(await own()).toBe(before)
    expect(await page.evaluate(() => window.nseFlushTest!.flusher.session?.chainId)).toBe(chains.A)
    await context.close()
})

test('Local Data › Recovery lists the unreadable recovered work', async ({
    browser,
    browserName,
}) => {
    test.skip(browserName === 'webkit', 'WebKit private contexts store no Blobs')
    // Catches a later build that loses a journal moved to the `recovered` store (the user's last
    // edits of an unreadable journal then cannot be downloaded).
    const { context, clock } = await profile(browser, browserName)
    const page = await visit(context, clock)
    await page.evaluate(async () => {
        const { openSettings } = await import('/src/editor/settings/openSettings.ts')
        void openSettings('localData')
    })
    const recovery = page.locator('[data-local-data-recovery]')
    await expect(recovery).toBeVisible()
    await expect(recovery.locator('[data-recovery-row="recovered"]')).toHaveCount(1)
    await expect(
        recovery.locator('[data-recovery-row="recovered"]').getByRole('button'),
    ).toContainText(['Download'])
    await context.close()
})

test('raw-export.zip’s dump.json seeds a fresh profile whose Recent Sessions lists its chains', async ({
    browser,
    browserName,
}) => {
    // Catches a later build that cannot load the editor's own raw-data export (the storage-bug
    // guide's way to a user's work, docs/release/storage-bug.md).
    // The seeder reads the ZIP itself: `dump.json` and each `blobs/<n>` entry its tags name. Private
    // WebKit contexts refuse Blobs, which the ZIP's media rows need.
    test.skip(browserName === 'webkit', 'a private WebKit context refuses the media Blobs')
    const bytes = new Uint8Array(readFileSync(join(webDir, 'raw-export.zip')))
    const zip = await ZipReader.open(new Blob([bytes]))
    const entry = zip.get('dump.json')!
    const dump = JSON.parse(
        new TextDecoder().decode(await zip.read(entry, { maxSize: 1 << 30 })),
    ) as DumpJson
    const expected = valuesOf(dump, 'chains')
        .filter((chain) => chain.deleting === undefined)
        .map((chain) => chain.chainId as string)
    const { context, clock } = await profile(browser, browserName, {
        dump,
        files: 'download',
        zip: bytes,
    })
    const page = await visit(context, clock)
    await openRecent(page)
    const listed = await page
        .locator('[data-sessions-row]')
        .evaluateAll((rows) => rows.map((each) => each.getAttribute('data-chain')))
    expect(listed.sort()).toEqual(expected.sort())
    await context.close()
})

test('a profile seeded from the download dump counts as saved, continues, and its Save downloads a file that opens fully', async ({
    browser,
    browserName,
}) => {
    test.setTimeout(120_000)
    // Catches a later build that reads a v1 download binding (`downloaded`, `confirmed`) as changed or
    // unsaved, or writes a file from a chain with `badChunks` that does not open.
    const download = readFixture('nse-local-data-download.json')
    const { context, clock } = await profile(browser, browserName, {
        dump: download,
        files: 'download',
    })
    const page = await visit(context, clock)
    const [chain] = valuesOf(download, 'chains') as [Record<string, unknown>]
    const name = (chain.file as { name: string }).name
    await expect(page.locator('[data-status-label]')).toContainText(name)
    // Counted as saved to its file: no chip asks to confirm it, no "changed" mark yet.
    await expect(page.locator('[data-file-chip]')).toHaveCount(0)
    expect(await page.evaluate(() => window.nseFlushTest!.flusher.session?.chainId)).toBe(
        chain.chainId,
    )
    const editor = await edit(page)
    void editor
    const downloading = page.waitForEvent('download')
    await page.locator('canvas.editor-chart').focus()
    await page.keyboard.press('p')
    const file = await downloading
    const bytes = new Uint8Array(readFileSync((await file.path())!))
    const read = await readNxsp(new Blob([bytes]))
    if (read.kind !== 'nxsp' || !read.history) throw new Error('The Save wrote no history')
    expect(read.open).toBe('full')
    expect(read.report).toEqual([])
    await closePage(page, { runBeforeUnload: false })
    await context.close()
})
