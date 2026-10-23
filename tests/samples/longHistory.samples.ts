import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { samplesDir } from '../../scripts/samples.mjs'
import { readDump, type Dump } from '../../src/local/dump'
import { Editor, prefix, SampleClock, seedContext } from './driver'

// The long-history sample (`npm run samples:long-history`): six days of use of coconut through the
// editor's own UI, with Playwright's clock (and the storage worker's Date) moved between actions,
// then a dump of the database (Part 1 §1.6.11.9) at samples/long-history.json. Load it with
// `?seedSample=long-history` on a dev server (src/local/seed.ts).

const root = resolve(import.meta.dirname, '../..')
const level = join(root, 'test_level_data/coconut-next-sekai-24887.json.gz')

/** A seeded generator, so a run makes the same choices. */
const random = (() => {
    let seed = 20261005
    return () => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
})()

const between = (min: number, max: number) => min + random() * (max - min)

const at = (local: string) => new Date(local).getTime()

const SECOND = 1000
const MINUTE = 60 * SECOND

type Note = { beat: number; left: number; size: number }

type Log = { visits: string[]; actions: Record<string, number>; missed: string[] }

/** One visit's driver: actions with the gaps a person leaves between them. */
class Session {
    constructor(
        readonly ed: Editor,
        readonly clock: SampleClock,
        readonly log: Log,
    ) {}

    get page() {
        return this.ed.page
    }

    /** A pause: seconds mostly, sometimes minutes away. */
    async think(scale = 1) {
        const ms =
            random() < 0.1 ? between(2 * MINUTE, 7 * MINUTE) : between(4 * SECOND, 50 * SECOND)
        await this.clock.pass(ms * scale)
    }

    /** Runs an action that should make an entry; counts it, or notes that it made none. */
    async act(name: string, fn: () => Promise<unknown>, pause = true) {
        const after = await this.ed.act(fn)
        if (after) this.log.actions[name] = (this.log.actions[name] ?? 0) + 1
        else {
            this.log.missed.push(name)
            console.log(`missed: ${name}`)
            if (process.env.SAMPLE_SHOTS)
                await this.page.screenshot({
                    path: join(process.env.SAMPLE_SHOTS, `missed-${this.log.missed.length}.png`),
                })
        }
        if (pause) await this.think()
        return after
    }

    /** Notes from one beat to another, by beat then lane. */
    async notesBetween(from: number, to: number) {
        return (await this.ed.notes())
            .filter((note) => note.beat >= from - 1e-6 && note.beat <= to + 1e-6)
            .sort((a, b) => a.beat - b.beat || a.left - b.left)
    }

    /** The widest note at a beat: a slide end or a tap, never one of its ticks. */
    async noteAt(beat: number) {
        const [note] = (await this.notesBetween(beat, beat)).sort((a, b) => b.size - a.size)
        if (!note) throw new Error(`No note at beat ${beat}`)
        return note
    }

    /** Drags a note by its middle, with the Select tool. */
    async move(note: Note, lanes: number, beats: number) {
        await this.deselect()
        await this.tool('f')
        const lane = note.left + note.size / 2
        await this.act('move', () =>
            this.ed.drag([lane, note.beat], [lane + lanes, note.beat + beats]),
        )
    }

    /** Drags a note's right end, with the Select tool. */
    async resize(note: Note, lanes: number) {
        await this.deselect()
        await this.tool('f')
        const edge = note.left + note.size - 0.12
        await this.act('resize', () => this.ed.drag([edge, note.beat], [edge + lanes, note.beat]))
    }

    /** Taps a note's middle with the Eraser. */
    async erase(note: Note) {
        await this.tool('g')
        await this.act('erase', () => this.ed.click(note.left + note.size / 2, note.beat))
    }

    async deselect() {
        await this.ed.command('Escape')
    }

    async tool(key: string) {
        await this.ed.command(key)
        await this.page.waitForTimeout(80)
    }

    /** The Note tool on preset n (1 tap, 2 critical, 3 flick, 4 trace), nothing selected. */
    async notePreset(n: number) {
        await this.deselect()
        await this.tool('f')
        await this.tool('a')
        for (let i = 1; i < n; i++) await this.tool('a')
    }

    async undo(times: number, name = 'undo') {
        for (let i = 0; i < times; i++) {
            await this.act(name, () => this.ed.command('z'), false)
            await this.clock.pass(between(0.4 * SECOND, 2 * SECOND))
        }
        await this.think()
    }

    async redo(times: number) {
        for (let i = 0; i < times; i++) {
            await this.act('redo', () => this.ed.command('y'), false)
            await this.clock.pass(between(0.4 * SECOND, 2 * SECOND))
        }
        await this.think()
    }

    /** A box selection with the Select tool. */
    async box(from: [number, number], to: [number, number]) {
        await this.deselect()
        await this.tool('f')
        await this.ed.drag(from, to)
        await this.page.waitForTimeout(80)
    }

    /** Lane steps in Properties, each committed: one entry each, so the Timeline shows ×N. */
    async scrub(field: string, steps: number, key = 'ArrowUp') {
        const input = this.page.getByRole('spinbutton', { name: field }).first()
        for (let i = 0; i < steps; i++) {
            await this.act(
                `scrub ${field}`,
                async () => {
                    await input.focus()
                    await this.ed.key(key)
                    await this.ed.key('Enter')
                },
                false,
            )
            await this.clock.pass(between(0.3 * SECOND, 1.5 * SECOND))
        }
        await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await this.think()
    }

    async levelLife(life: number) {
        await this.act('level properties', async () => {
            await this.page.locator('[data-status-label]').click()
            const dialog = this.page.getByRole('dialog', { name: 'Level Info' })
            await dialog.getByRole('spinbutton', { name: 'Initial Life' }).fill(String(life))
            await dialog.getByRole('button', { name: 'Confirm' }).click()
        })
    }

    async exportLevel(name: string) {
        const download = this.page.waitForEvent('download')
        await this.ed.command('Shift+P')
        const field = this.page.getByRole('dialog').getByRole('textbox', { name: 'File Name' })
        await field.fill(name)
        await field.press('Enter')
        await download
        await expect(this.page.getByRole('dialog')).toHaveCount(0)
        this.log.actions.export = (this.log.actions.export ?? 0) + 1
        await this.think()
    }

    async openHistory() {
        const list = this.page.locator('[data-history-list]')
        if (!(await list.isVisible())) await this.ed.command('Shift+H')
        await list.waitFor()
        return list
    }

    async closeHistory() {
        if (await this.page.locator('[data-history-list]').isVisible())
            await this.ed.command('Shift+H')
    }

    /** Restore from History: a right click on a row's Restore. */
    async restore(label: string | RegExp, nth = 0) {
        const list = await this.openHistory()
        await this.act('restore', async () => {
            const row = list.getByRole('row').filter({ hasText: label }).nth(nth)
            // The list is windowed: wheel down until the row is drawn.
            const box = await list.boundingBox()
            if (box) await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            for (let i = 0; i < 40 && !(await row.count()); i++) {
                await this.page.mouse.wheel(0, 300)
                await this.page.waitForTimeout(50)
            }
            if (!(await row.count())) {
                const seen = new Set<string>()
                for (let i = 0; i < 80; i++) {
                    for (const text of await list.getByRole('row').allInnerTexts())
                        seen.add(text.replace(/\s+/g, ' '))
                    await this.page.mouse.wheel(0, -300)
                    await this.page.waitForTimeout(50)
                }
                throw new Error(`No row ${String(label)}; seen:\n${[...seen].join('\n')}`)
            }
            await row.scrollIntoViewIfNeeded()
            await row.click({ button: 'right' })
            await this.page.getByRole('menuitem', { name: 'Restore' }).click()
        })
        await this.closeHistory()
    }

    async panel(tab: 'Groups' | 'Stages') {
        const button = this.page.getByRole('button', { name: `Add ${tab.slice(0, -1)}` })
        if (!(await button.isVisible())) await this.page.getByRole('tab', { name: tab }).click()
        return button
    }

    /** Adds a group or stage, then names it in its field. */
    async addNamed(tab: 'Groups' | 'Stages', name: string) {
        const button = await this.panel(tab)
        await this.act(`add ${tab}`, () => button.click(), false)
        await this.page.keyboard.type(name, { delay: 60 })
        await this.act(`rename ${tab}`, () => this.ed.key('Enter'))
    }

    /** Picks an option of a Properties select. */
    async choose(field: string, option: string | RegExp) {
        await this.act(`set ${field}`, async () => {
            await this.page.getByRole('combobox', { name: field }).first().click()
            await this.page.getByRole('option', { name: option }).first().click()
        })
    }

    /** Stores everything, then leaves: the tab closes. */
    async leave() {
        if (process.env.SAMPLE_SHOTS) {
            await this.openHistory()
            await this.page.screenshot({
                path: join(process.env.SAMPLE_SHOTS, `${this.log.visits.length}.png`),
            })
        }
        await this.ed.flush()
        await this.ed.settled()
        await this.page.close()
    }
}

/** The first beat after coconut's last note, where each visit works in its own stretch. */
let end = 0
const region = (k: number) => end + 10 + k * 16

const visit = async (
    context: BrowserContext,
    clock: SampleClock,
    log: Log,
    time: string,
    label: string,
) => {
    await clock.passTo(at(time))
    const ed = await Editor.visit(context, clock)
    log.visits.push(`${time} ${label}`)
    return new Session(ed, clock, log)
}

/** Places a row of notes: lanes and beats from the pattern, one entry each. */
const placeRow = async (s: Session, preset: number, notes: [number, number][], name: string) => {
    await s.notePreset(preset)
    for (const [lane, beat] of notes) await s.act(name, () => s.ed.click(lane, beat))
}

/**
 * A stretch of charting in its own region: two notes a half beat apart down the stretch, the
 * preset changing now and then, and an undo run every so often (a redo, then a branch).
 */
const compose = async (s: Session, k: number, count: number) => {
    const b = region(k)
    await s.ed.focus(b)
    const presets = [1, 1, 2, 1, 3, 1, 4, 1]
    let preset = 0
    for (let i = 0; i < count; i++) {
        if (i % 6 === 0) {
            preset = presets[(i / 6 + k) % presets.length]!
            await s.notePreset(preset)
        }
        const beat = b - 6 + Math.floor(i / 2) * 0.5
        const lane = i % 2 ? 2 + ((i * 3) % 4) : -6 + ((i * 5) % 4)
        await s.act(['tap', 'critical', 'flick', 'trace'][preset - 1]!, () =>
            s.ed.click(lane, beat),
        )
        if (i % 10 === 9) {
            await s.undo(2)
            await s.redo(1)
        }
    }
}

/** A slide from start to end with a middle note, then ticks generated along it. */
const slide = async (s: Session, b: number, lane: number, critical = false) => {
    await s.deselect()
    await s.tool('f')
    await s.tool('s')
    if (critical) await s.tool('s')
    await s.act('slide start', () => s.ed.click(lane, b))
    await s.act('slide end', () => s.ed.click(lane + 3, b + 3))
    await s.act('slide middle', () => s.ed.click(lane + 1, b + 1.5))
    await s.tool('j')
    await s.act('generate ticks', () => s.ed.click(lane + 1, b + 1.5))
    await s.deselect()
}

/** Day 1, morning: coconut opened, taps, criticals, flicks and traces, an undo run, an export. */
const day1Morning = async (s: Session) => {
    const chooser = s.page.waitForEvent('filechooser')
    await s.ed.command('o')
    await (
        await chooser
    ).setFiles({
        name: 'coconut-next-sekai-24887.json.gz',
        mimeType: 'application/gzip',
        buffer: readFileSync(level),
    })
    await s.page.getByRole('button', { name: 'OK' }).click()
    end = Math.max(...(await s.ed.notes()).map((note) => note.beat)) + 1
    for (let i = 0; i < 20; i++) await s.ed.command('-')
    await s.think()
    const b = region(0)
    await s.ed.focus(b)
    await placeRow(
        s,
        1,
        [-4, -2, 0, 2, 4, -3, 1, 3].map((lane, i) => [lane, b - 5 + i * 0.5] as [number, number]),
        'tap',
    )
    await placeRow(
        s,
        2,
        [
            [-1, b - 0.5],
            [3, b],
            [-5, b + 0.5],
        ],
        'critical',
    )
    await s.undo(3)
    await s.redo(2)
    await placeRow(
        s,
        3,
        [
            [-4, b + 1.5],
            [0, b + 2],
            [4, b + 2.5],
        ],
        'flick',
    )
    await placeRow(
        s,
        4,
        [
            [-2, b + 3.5],
            [2, b + 4],
        ],
        'trace',
    )
    await s.undo(1)
    // A new edit after an undo: the undone trace is a branch Undo cannot reach.
    await placeRow(s, 4, [[1, b + 4.5]], 'trace')
    await s.levelLife(1100)
    await s.exportLevel('coconut')
    await compose(s, 6, 40)
    await s.leave()
}

/** Day 1, afternoon: slides with ticks, moves and resizes by drag, a reload mid-session. */
const day1Afternoon = async (s: Session) => {
    const b = region(1)
    await s.ed.focus(b)
    await slide(s, b - 5, -6)
    await slide(s, b - 1, 1, true)
    // Stored first, so a slow machine cannot make the reload race the flush and add a `recovered` entry.
    await s.ed.flush()
    await s.ed.settled()
    await s.ed.reload()
    await s.think(4)
    await s.ed.focus(b)
    await slide(s, b + 3, -3)
    // Moves by drag: slide starts and ends.
    await s.move(await s.noteAt(b - 5), 1, 0.5)
    await s.move(await s.noteAt(b - 1), 1, 0)
    await s.move(await s.noteAt(b + 2), -1, 0.5)
    await s.move(await s.noteAt(b + 3), 1, 0)
    // Resizes by an end.
    await s.resize(await s.noteAt(b + 6), 2)
    await s.undo(4)
    await s.redo(4)
    await s.resize(await s.noteAt(b + 3), 1)
    await compose(s, 7, 30)
    await s.leave()
}

/** Day 2: box selection, multi-edit and scrubs in Properties, clipboard, flip, the eraser. */
const day2 = async (s: Session) => {
    const b = region(0)
    await s.ed.focus(b)
    await s.box([-7, b - 5.25], [6, b - 1.75])
    await s.act('multi-edit critical', () =>
        s.page.getByRole('checkbox', { name: 'Critical' }).first().click(),
    )
    await s.scrub('Lane', 4)
    await s.scrub('Lane', 5, 'ArrowDown')
    await s.scrub('Size', 3)
    await s.ed.command('c')
    await s.tool('v')
    await s.act('paste', () => s.ed.click(0, b + 6))
    await s.box([-7, b + 1.25], [6, b + 2.75])
    await s.act('flip', () => s.ed.command('u'))
    await s.act('cut', () => s.ed.command('x'))
    // Pasted back further down.
    await s.tool('v')
    await s.act('paste', () => s.ed.click(-2, b + 4.5))
    await s.undo(2)
    await s.redo(1)
    for (const note of (await s.notesBetween(b - 5, b - 3)).slice(0, 3)) await s.erase(note)
    await s.undo(1)
    // Coconut's own notes: a box in the middle of the chart, flipped, then flipped back by undo.
    await s.ed.focus(160)
    await s.box([-7.8, 156.75], [7.8, 163.25])
    await s.act('flip', () => s.ed.command('u'))
    await s.undo(1)
    await s.act('flip', () => s.ed.command('u'))
    await compose(s, 8, 30)
    await s.leave()
}

/** Day 2, evening: a short visit, a few taps and a branch. */
const day2Evening = async (s: Session) => {
    const b = region(2)
    await s.ed.focus(b)
    await placeRow(
        s,
        1,
        [-3, 3, -1, 1, -5, 5].map((lane, i) => [lane, b - 4 + i] as [number, number]),
        'tap',
    )
    await s.undo(2)
    await placeRow(s, 3, [[0, b + 3]], 'flick')
    await compose(s, 9, 20)
    await s.leave()
}

/** Day 4: BPM, time-scale and stage-style events, groups and stages; a Duplicate Tab fork. */
const day4 = async (s: Session, context: BrowserContext, clock: SampleClock, log: Log) => {
    const b = region(3)
    await s.ed.focus(b)
    await s.tool('q')
    await s.act('bpm', () => s.ed.click(6, b - 4))
    await s.act('bpm', () => s.ed.click(6, b + 4))
    await s.tool('w')
    for (const beat of [b - 3, b, b + 3]) await s.act('time scale', () => s.ed.click(-6, beat))
    await s.tool('d')
    for (let i = 0; i < 3; i++) await s.tool('d')
    for (const beat of [b - 2, b + 2]) await s.act('stage style', () => s.ed.click(5, beat))
    await s.undo(1)
    await s.addNamed('Groups', 'Outro')
    await s.addNamed('Stages', 'Side')
    await placeRow(
        s,
        1,
        [-2, 2, -2, 2].map((lane, i) => [lane, b - 1 + i] as [number, number]),
        'tap',
    )
    await s.box([-4, b - 1.25], [4, b + 2.25])
    await s.choose('Group', 'Outro')
    await s.choose('Stage', 'Side')
    // Duplicate Tab: a second tab takes this one's sessionStorage and forks a separate copy.
    await s.ed.flush()
    await s.ed.settled()
    const record = await s.page.evaluate((key) => sessionStorage.getItem(key), `${prefix}tab`)
    await clock.pass(40 * SECOND)
    const page: Page = await context.newPage()
    clock.track(page)
    await page.addInitScript(
        ({ key, record }) => {
            if (!sessionStorage.getItem('nse.sample.copied') && record) {
                sessionStorage.setItem(key, record)
                sessionStorage.setItem('nse.sample.copied', 'true')
            }
        },
        { key: `${prefix}tab`, record },
    )
    await page.goto('/')
    const copy = new Session(new Editor(page), clock, log)
    await copy.ed.ready()
    log.visits.push('Duplicate Tab')
    await copy.ed.focus(b + 8)
    await placeRow(
        copy,
        2,
        [-4, 0, 4].map((lane, i) => [lane, b + 6 + i] as [number, number]),
        'critical (fork)',
    )
    await copy.levelLife(900)
    await compose(copy, 11, 12)
    await copy.leave()
    await s.page.bringToFront()
    await s.ed.focus(b)
    await s.box([-4, b - 1.25], [4, b + 2.25])
    await s.act('flip', () => s.ed.command('u'))
    await compose(s, 10, 30)
    await s.leave()
}

/** Day 5: Restore from History, more edits, long scrubs, an export. */
const day5 = async (s: Session) => {
    await s.restore(/^Set Group/)
    const b = region(4)
    await s.ed.focus(b)
    await placeRow(
        s,
        1,
        [-5, -3, -1, 1, 3, 5, 3, 1, -1, -3].map((lane, i) => [lane, b - 5 + i] as [number, number]),
        'tap',
    )
    await s.box([-7, b - 5.25], [7, b - 0.75])
    await s.scrub('Size', 12)
    await s.choose('Flick Direction', 'Up')
    await s.undo(3)
    await s.redo(3)
    await s.undo(2)
    await s.act('multi-edit critical', () =>
        s.page.getByRole('checkbox', { name: 'Critical' }).first().click(),
    )
    await slide(s, b + 1, -2)
    await s.exportLevel('coconut v2')
    await compose(s, 12, 40)
    await s.leave()
}

/** Day 6: a last pass with the eraser, more taps, the level's life, a final export. */
const day6 = async (s: Session) => {
    const b = region(4)
    await s.ed.focus(b)
    for (const note of [await s.noteAt(b - 5), await s.noteAt(b)]) await s.erase(note)
    const c = region(5)
    await s.ed.focus(c)
    await placeRow(
        s,
        3,
        [-4, -1, 2, 5].map((lane, i) => [lane, c - 3 + i] as [number, number]),
        'flick',
    )
    await placeRow(
        s,
        1,
        [-4, -1, 2, 5].map((lane, i) => [lane, c + 1 + i] as [number, number]),
        'tap',
    )
    await s.undo(5)
    await s.redo(2)
    await s.levelLife(1000)
    await s.restore(/^Added 1 note/)
    await s.exportLevel('coconut final')
    await compose(s, 13, 30)
    await s.leave()
}

/** Reads the database in a page that loads no editor code, through the dumper alone. */
const dump = async (context: BrowserContext) => {
    const page = await context.newPage()
    await page.route('**/__sample-dump', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>dump</title>' }),
    )
    await page.goto('/__sample-dump')
    const result = await page.evaluate(async (prefix) => {
        const { dumpDatabase, dumpLocalStorage } =
            (await import('/src/local/dump.ts')) as typeof import('../../src/local/dump')
        const { idbFactory } =
            (await import('/src/local/kv/idb.ts')) as typeof import('../../src/local/kv/idb')
        const { appVersion } =
            (await import('/src/platform/version.ts')) as typeof import('../../src/platform/version')
        const db = await idbFactory(indexedDB).open('nse-local-data', undefined)
        const storage = dumpLocalStorage(localStorage, prefix)
        // The panels the generator hid for speed are not part of the sample.
        delete storage[`${prefix}showPreview`]
        const dumped = await dumpDatabase(db, {
            appVersion: appVersion().appVersion,
            localStorage: storage,
        })
        db.close()
        return JSON.stringify(dumped)
    }, prefix)
    await page.close()
    return readDump(JSON.parse(result)) as Dump
}

/** Counts for the README: entries by kind, sessions, chains, the days of use. */
const summarize = (dump: Dump, log: Log) => {
    const rows = (name: string) =>
        dump.stores.find((store) => store.name === name)?.records.map((r) => r.value) ?? []
    const entries = rows('entries') as { kind: string; time: number; label?: string }[]
    const kinds: Record<string, number> = {}
    for (const entry of entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1
    const days = new Set(entries.map((entry) => new Date(entry.time).toDateString()))
    const times = entries.map((entry) => entry.time).sort((a, b) => a - b)
    return {
        entries: entries.length,
        kinds,
        sessions: rows('sessions').length,
        chains: rows('chains').length,
        days: [...days],
        from: new Date(times[0] ?? 0).toString(),
        to: new Date(times.at(-1) ?? 0).toString(),
        visits: log.visits,
        actions: log.actions,
        missed: log.missed,
        journals: Object.keys(dump.localStorage).filter((key) => key.includes('journal')),
    }
}

const rowsTimes = (dump: Dump) =>
    (dump.stores.find((store) => store.name === 'entries')?.records ?? []).map(
        (r) => (r.value as { time: number }).time,
    )

test('long-history sample', async ({ browser }) => {
    const context = await browser.newContext()
    // Dates are relative to the generation time: the six days end on the day it runs, and the last
    // visit starts early enough to end before now (on the day before, in the first two hours).
    const now = new Date()
    const nowMinutes = now.getHours() * 60 + now.getMinutes()
    const early = nowMinutes < 120
    const lastStart = early ? 16 * 60 + 45 : Math.min(16 * 60 + 45, nowMinutes - 90)
    const lastDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (early ? 1 : 0))
    const pad = (n: number) => String(n).padStart(2, '0')
    /** Local time on the day `back` days before the last day. */
    const when = (back: number, hhmm: string) => {
        const d = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() - back)
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hhmm}:00`
    }
    const lastTime = `${pad(Math.floor(lastStart / 60))}:${pad(lastStart % 60)}`
    const clock = new SampleClock(context, at(when(5, '09:10')))
    await clock.install()
    await seedContext(context)
    await context.addInitScript((prefix) => {
        // Faster in software rendering; left out of the dump.
        localStorage.setItem(`${prefix}showPreview`, 'false')
    }, prefix)
    const log: Log = { visits: [], actions: {}, missed: [] }
    // SAMPLE_VISITS=n stops after n visits, without writing the sample (for working on the script).
    const limit = Number(process.env.SAMPLE_VISITS ?? Infinity)
    const go = async (time: string, label: string) => {
        if (log.visits.length >= limit) test.skip(true, `Stopped after ${limit} visits`)
        const s = await visit(context, clock, log, time, label)
        console.log(`${time} ${label}: ${JSON.stringify(await s.ed.head())}`)
        return s
    }

    await day1Morning(await go(when(5, '09:12'), 'first visit: coconut opened'))
    await day1Afternoon(await go(when(5, '13:47'), 'new visit (continue), with a reload'))
    await day2(await go(when(4, '10:05'), 'new visit'))
    await day2Evening(await go(when(4, '21:32'), 'new visit'))
    await day4(await go(when(2, '15:20'), 'new visit, Duplicate Tab'), context, clock, log)
    await day5(await go(when(1, '11:02'), 'new visit, Restore from History'))
    await day6(await go(when(0, lastTime), 'new visit'))

    const result = await dump(context)
    const summary = summarize(result, log)
    console.log(JSON.stringify(summary, null, 2))
    const dir = samplesDir(root)
    if (!dir) throw new Error('No samples/ folder found; set NSE_SAMPLES_DIR')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'long-history.json'), `${JSON.stringify(result)}\n`)
    writeFileSync(
        join(root, 'test-results/samples/long-history.summary.json'),
        `${JSON.stringify(summary, null, 2)}\n`,
    )
    expect(summary.missed).toEqual([])
    expect(Math.max(...rowsTimes(result))).toBeLessThan(Date.now())
    await context.close()
})
