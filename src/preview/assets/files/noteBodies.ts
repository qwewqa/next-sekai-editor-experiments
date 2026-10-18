import { SkinSpriteName } from '@sonolus/core'

// The note bodies the skin resolver looks for (`resolveSkin`): normal, critical, flick and trace.
const prefixes = [
    'Sekai Normal Note',
    'Sekai Note Cyan',
    'Sekai Slide Note',
    'Sekai Note Green',
    'Sekai Flick Note',
    'Sekai Note Red',
    'Sekai Down Flick Note',
    'Sekai Critical Note',
    'Sekai Note Yellow',
    'Sekai Critical Slide Note',
    'Sekai Critical Flick Note',
    'Sekai Critical Down Flick Note',
    'Sekai Trace Note Green',
    'Sekai Trace Note Red',
    'Sekai Trace Note Yellow',
    'Sekai Trace Note Purple',
    'Sekai Normal Trace Note',
    'Sekai Trace Flick Note',
    'Sekai Trace Down Flick Note',
    'Sekai Critical Trace Note',
    'Sekai Critical Trace Flick Note',
    'Sekai Critical Trace Down Flick Note',
]

const bodyNames = new Set<string>([
    ...prefixes.map((prefix) => `${prefix} Middle`),
    SkinSpriteName.NoteHeadCyan,
    SkinSpriteName.NoteHeadGreen,
    SkinSpriteName.NoteHeadRed,
    SkinSpriteName.NoteHeadYellow,
])

/** Whether a sprite is a body the preview can draw a note with. */
export const isNoteBody = (name: string) => bodyNames.has(name)
