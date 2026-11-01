import type { Chart } from '../../src/chart'
import type { NoteObject, NoteType } from '../../src/chart/note'
import { createState } from '../../src/state'
import { goldenChart, group, note } from '../local/records/charts'

export const soundClips = [
    'normalTap',
    'criticalTap',
    'normalFlick',
    'criticalFlick',
    'normalTrace',
    'criticalTrace',
    'normalTick',
    'criticalTick',
    'normalActive',
    'criticalActive',
] as const

const chart = (slides: NoteObject[][]): Chart => ({
    ...goldenChart().chart,
    bpms: [
        { beat: 0, bpm: 60 },
        { beat: 4, bpm: 120 },
    ],
    timeScales: [],
    slides,
})

export const soundCharts = () => {
    const kinds = chart([])
    let beat = 0
    for (const noteType of [
        'default',
        'trace',
        'anchor',
        'damage',
        'forceTick',
        'forceNonTick',
    ] as NoteType[]) {
        for (const isCritical of [false, true]) {
            for (const flickDirection of ['none', 'up'] as const) {
                kinds.slides.push([note(beat, { noteType, isCritical, flickDirection })])
                beat += 0.25
            }
        }
    }
    for (const sfx of [...soundClips.slice(0, 8), 'none', 'damage'] as NoteObject['sfx'][]) {
        kinds.slides.push([note(beat, { sfx })])
        beat += 0.25
    }
    kinds.slides.push(
        [note(beat, { isFake: true })],
        [note(beat, { noteType: 'anchor', sfx: 'criticalTap' })],
    )

    const holds = chart([
        [note(0), note(2, { isAttached: true }), note(5)],
        [note(0.5), note(1.5)],
        [note(4.5), note(7)],
        [
            note(0, { groupId: group(2), connectorActiveIsCritical: true }),
            note(6, { groupId: group(2) }),
        ],
        [note(2, { connectorType: 'guide' }), note(3)],
        [note(2, { connectorType: 'damage' }), note(3)],
    ])
    holds.timeScales = [
        {
            groupId: group(1),
            beat: 1,
            editorLane: 0,
            timeScale: 1,
            skip: 0,
            timeScaleEase: 'linear',
            timeScaleTransition: 'timeScale',
            hideNotes: true,
        },
        {
            groupId: group(1),
            beat: 2,
            editorLane: 0,
            timeScale: 1,
            skip: 0,
            timeScaleEase: 'linear',
            timeScaleTransition: 'timeScale',
            hideNotes: false,
        },
    ]

    const spacing = chart([
        ...[0, 0, 0.01, 0.021, 0.74, 0.75, 0.761, 1.5, 1.51, 2.5].map((beat) => [note(beat)]),
        [note(0, { isCritical: true })],
        [note(0, { flickDirection: 'up' })],
        [note(0, { sfx: 'normalTrace' })],
        [note(0, { connectorActiveIsCritical: true }), note(4)],
        [note(4), note(8)],
    ])
    return [kinds, holds, spacing].map((chart) => createState(chart, -0.3))
}
