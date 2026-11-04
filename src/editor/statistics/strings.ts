import type en from '../../i18n/en/index.json'
import type { Category, Row, StatisticsStrings } from '../../levelData/statistics'
import { fill } from '../../utils/interpolate'

/** Tap and Flick's name: the chosen one of the two, else both joined. */
export const tapAndFlickName = (t: typeof en, chosen: readonly Category[]) => {
    const { normalTap, normalFlick } = t.modals.form.sfx
    const tap = chosen.includes('tap')
    const flick = chosen.includes('flick')
    if (tap !== flick) return tap ? normalTap : normalFlick
    return fill(t.statistics.tapAndFlick, [normalTap, normalFlick])
}

/**
 * The names and messages the dialog, Copy Text and the share card share, from a locale's messages
 * and the chosen categories.
 */
export const statisticsStringsOf = (
    t: typeof en,
    chosen: readonly Category[],
): StatisticsStrings => {
    const { statistics, modals } = t
    const sfx = modals.form.sfx
    const names = {
        tap: sfx.normalTap,
        flick: sfx.normalFlick,
        release: statistics.release,
        trace: sfx.normalTrace,
        traceFlick: statistics.traceFlick,
        tick: sfx.normalTick,
    }
    const rows: Record<Row, string> = {
        ...names,
        hiddenTick: statistics.hiddenTick,
        damageNote: statistics.damageNote,
        damageTick: statistics.damageTick,
        fakeNote: statistics.fakeNote,
    }
    const categories: Record<Category, string> = { ...names, damage: modals.form.noteType.damage }
    return {
        combo: statistics.combo,
        rows,
        categories,
        withCritical: statistics.withCritical,
        notesPerSecond: statistics.notesPerSecond,
        noNotes: statistics.noNotes,
        average: statistics.average,
        median: statistics.median,
        p90: statistics.p90,
        p99: statistics.p99,
        primary: tapAndFlickName(t, chosen),
        all: statistics.all,
        withAll: statistics.withAll,
        firstComboNote: statistics.firstComboNote,
        lastComboNote: statistics.lastComboNote,
        lastNote: statistics.lastNote,
        bgmEnd: statistics.bgmEnd,
        textLine: modals.form.choiceLine,
    }
}
