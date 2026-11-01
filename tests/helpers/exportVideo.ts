import type { SoundSource } from '../../src/playerSounds'
import { createState, type State } from '../../src/state'
import { goldenChart, note } from '../local/records/charts'

export const exportSoundState = (start = 0) =>
    createState(
        {
            ...goldenChart().chart,
            bpms: [{ beat: 0, bpm: 60 }],
            timeScales: [],
            slides: [
                [note(start - 1), note(start + 11)],
                [note(start + 9.95, { sfx: 'criticalTap' })],
                [note(start + 0.02, { sfx: 'criticalTap' })],
                [note(start + 0.021, { sfx: 'criticalTap' })],
                [note(start + 0.04, { sfx: 'normalFlick' })],
            ],
        },
        0,
    )

export const exportSoundSource = ({ store }: State): SoundSource => ({
    notes: new Set([...store.grid.note.values()].flatMap((bucket) => [...bucket])),
    connectors: new Set([...store.grid.connector.values()].flatMap((bucket) => [...bucket])),
    getInfo: (note) => store.slides.info.get(note.slideId)?.find((info) => info.note === note),
    getHideChanges: () => [],
})
