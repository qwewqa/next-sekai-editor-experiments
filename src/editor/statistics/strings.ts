import type en from '../../i18n/en/index.json'
import type { Category, Row, StatisticsStrings } from '../../levelData/statistics'

/** The names and messages the dialog, Copy Text and the share card share, from a locale's messages. */
export const statisticsStringsOf = (t: typeof en): StatisticsStrings => {
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
        firstComboNote: statistics.firstComboNote,
        lastComboNote: statistics.lastComboNote,
        lastNote: statistics.lastNote,
        bgmEnd: statistics.bgmEnd,
        textLine: statistics.textLine,
    }
}
