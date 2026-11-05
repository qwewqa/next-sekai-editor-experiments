import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { readZip } from '../../builtin-assets/zip.mjs'
import { readBuiltinItem } from './helpers.mjs'

// Sonolus maps a sprite's texture onto the quad its transform gives with perspective interpolation,
// so two sprites place their art alike only on the same quad. The variants of one role (normal and
// critical, every style colour, the legacy colour names) therefore share one transform, and any
// variant that needs more room (a critical halo) gets it in every variant of its family.

const color = '(?: (?:Neutral|Red|Green|Blue|Yellow|Purple|Cyan|Black))?'
const part = '(Left|Middle|Right)'
const traceKind = '(?:Trace|Trace Flick|Trace Down Flick)'
const slotKind =
    '(?:Normal|Slide|Flick|Down Flick|Critical|Critical Slide|Critical Flick|Critical Down Flick|Cyan|Green|Red|Yellow|Yellow Flick|Yellow Slider)'

// [family, pattern]; a pattern's groups (a slice, a direction and width) name the family's member.
const families = [
    ['body', `^Sekai (?:Normal |Critical )?(?:Slide |Flick |Down Flick )?Note ${part}${color}$`],
    ['body', `^Sekai Note (?:Cyan|Green|Red|Yellow) ${part}$`],
    ['trace', `^Sekai (?:Normal |Critical )?${traceKind} Note ${part}${color}$`],
    ['trace', `^Sekai Trace Note (?:Green|Red|Yellow) ${part}$`],
    ['damage', `^Sekai Damage Note ${part}${color}$`],
    ['damage', `^Sekai Trace Note Purple ${part}$`],
    ['whole trace', '^Sekai Trace Note (?:Green|Red|Yellow|Purple)$'],
    [
        'basic body',
        `^Sekai (?:Normal |Critical )?(?:Slide |Flick |Down Flick )?Note Basic${color}$`,
    ],
    ['basic bar', `^Sekai (?:Normal |Critical )?(?:${traceKind}|Damage) Note Basic${color}$`],
    ['note head', '^#NOTE_(HEAD|TAIL)_[A-Z]+$'],
    ['slide diamond', `^Sekai (?:Normal|Critical) Slide Diamond${color}$`],
    ['slide diamond', '^Sekai Diamond (?:Green|Yellow)$'],
    ['trace diamond', `^Sekai (?:Normal |Critical )?${traceKind} Diamond${color}$`],
    ['trace diamond', '^Sekai Trace Diamond (?:Green|Red|Yellow)$'],
    ['tick', '^#NOTE_TICK_[A-Z]+$'],
    [
        'arrow',
        `^Sekai (?:Critical )?Flick Arrow(?: Red| Yellow)? (Up|Up Left|Down|Down Left) ([1-6])${color}$`,
    ],
    ['marker', '^#DIRECTIONAL_MARKER_[A-Z]+$'],
    ['slot', `^Sekai Slot ${slotKind}${color}$`],
    ['slot glow', '^Sekai Slot Glow .+$'],
    ['slot glow', `^Sekai (?:Normal|Critical) Slide Slot Glow${color}$`],
    ['connector', '^Sekai (?:Normal |Critical |Damage )?(?:Active )?Slide Connection'],
    ['standard connector', '^#NOTE_CONNECTION_[A-Z]+(?:_SEAMLESS)?$'],
    ['sim line', '^#SIMULTANEOUS_CONNECTION_[A-Z]+(?:_SEAMLESS)?$'],
    ['guide', `^Sekai Guide${color}$`],
    ['grid', '^#GRID_[A-Z]+$'],
    ['lane', `^Sekai Lane Background${color}$`],
    ['lane preview', `^Sekai Lane Background Preview${color}$`],
    ['judgment gradient', `^Sekai Judgment Gradient${color}$`],
    ['judgment edge', `^Sekai Judgment Edge${color}$`],
    ['judgment edge left', `^Sekai Judgment Edge Left${color}$`],
    ['judgment single line', `^Sekai Judgment Single Line${color}$`],
    ['judgment centre', `^Sekai Judgment Center${color}$`],
].map(([name, pattern]) => [name, new RegExp(pattern)])

/** The family of a sprite name, or undefined for a sprite with no variants. */
function familyOf(name) {
    for (const [family, pattern] of families) {
        const match = pattern.exec(name)
        if (match) return [family, ...match.slice(1).filter(Boolean)].join(' ')
    }
    return undefined
}

// The base's legacy connections (Sekai Slide Connection Green and the like) are 1 px stand-ins the
// engine does not draw.
const placeholder = ({ w, h }) => w === 1 && h === 1

const transformKey = (transform) =>
    JSON.stringify(
        Object.keys(transform ?? {})
            .sort()
            .map((corner) =>
                Object.entries(transform[corner])
                    .filter(([, weight]) => Math.abs(weight) > 1e-9)
                    .sort(([a], [b]) => (a < b ? -1 : 1))
                    .map(([key, weight]) => [key, Math.round(weight * 1e6) / 1e6]),
            ),
    )

/** For each family whose sprites do not share one transform, its sprites grouped by transform. */
function mismatches(sprites) {
    const byFamily = new Map()
    for (const sprite of sprites) {
        const family = familyOf(sprite.name)
        if (!family || placeholder(sprite)) continue
        const transforms = byFamily.get(family) ?? new Map()
        const key = transformKey(sprite.transform)
        transforms.set(key, [...(transforms.get(key) ?? []), sprite.name])
        byFamily.set(family, transforms)
    }
    return [...byFamily]
        .filter(([, transforms]) => transforms.size > 1)
        .map(
            ([family, transforms]) =>
                `${family}: ${[...transforms.values()].map((names) => names[0]).join(' | ')}`,
        )
}

test('the variants of each Built-in sprite share one transform', () => {
    const sprites = readBuiltinItem('skin').json('data').sprites
    assert.deepEqual(mismatches(sprites), [])
    // Every name that names a kind or colour belongs to a family.
    const variant =
        /Normal|Critical|Neutral|Red|Green|Blue|Yellow|Purple|Cyan|Black|_(NEUTRAL|RED|GREEN|BLUE|YELLOW|PURPLE|CYAN)(_|$)/
    const loose = sprites
        .map(({ name }) => name)
        .filter((name) => variant.test(name) && !familyOf(name))
    assert.deepEqual(loose, [])
})

const base = new URL('../../public/resource/skin.scp', import.meta.url)

// Where the Next SEKAI 01 skin is staged, its families share one transform too, so the families
// above are the engine's.
test(
    "the base skin's variants share one transform",
    { skip: !existsSync(base) && 'the Next SEKAI 01 skin is not in public/resource/' },
    () => {
        const data = JSON.parse(gunzipSync(readZip(readFileSync(base)).get('data')))
        assert.deepEqual(mismatches(data.sprites), [])
    },
)
