// Writes tests/fixtures/generated-large.json, a deterministic level data file about the size of
// coconut (3,500 entities, 1.4 MB) with a similar archetype mix. Run: npm run fixtures:generated-large
// `--stdout` prints it instead; `generateLargeChart()` returns the text.
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const seed = 0x5e4a1c0
const endBeat = 370

// mulberry32
const createRandom = (seed) => {
    let state = seed >>> 0
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

export const generateLargeChart = () => {
    const random = createRandom(seed)
    const int = (n) => Math.floor(random() * n)
    const pick = (items) => items[int(items.length)]
    const chance = (p) => random() < p
    const weighted = (entries) => {
        let x = random() * entries.reduce((sum, [, weight]) => sum + weight, 0)
        for (const [value, weight] of entries) if ((x -= weight) < 0) return value
        return entries.at(-1)[0]
    }
    const shuffle = (items) => {
        for (let i = items.length - 1; i > 0; i--) {
            const j = int(i + 1)
            ;[items[i], items[j]] = [items[j], items[i]]
        }
        return items
    }

    let counter = 0
    const newName = () => (counter++).toString(16)

    const datum = (name, value) => ({ name, value })
    const ref = (name, target) => ({ name, ref: target })
    const entity = (archetype, data, name) =>
        name ? { archetype, data, name } : { archetype, data }

    // Beats come in 1/24 steps, so thirds and eighths both appear.
    const beatOf = (ticks) => ticks / 24
    const quarter = (min, max) => min + int(Math.round((max - min) * 4) + 1) / 4

    const groups = Array.from({ length: 6 }, (_, i) => ({
        name: newName(),
        editorName: i === 0 ? 'Default' : `#${i}`,
        forceNoteSpeed: i === 5 ? 10.85 : undefined,
        weight: [60, 12, 8, 6, 4, 10][i],
    }))
    const stages = Array.from({ length: 4 }, (_, i) => ({
        name: newName(),
        editorName: i === 0 ? 'Default' : `#${i}`,
        weight: [90, 5, 3, 2][i],
    }))
    const pickGroup = () => weighted(groups.map((group) => [group, group.weight]))
    const pickStage = () => weighted(stages.map((stage) => [stage, stage.weight]))

    // A chain of changes, each naming the next; `make` fills the data from a changing beat.
    const chain = (archetype, beats, make) => {
        const names = beats.map(newName)
        const entities = beats.map((beat, i) => {
            const data = make(beat, i)
            if (i < beats.length - 1) data.push(ref('next', names[i + 1]))
            return entity(archetype, data, names[i])
        })
        return { first: names[0], entities }
    }
    const ascending = (count, start, steps, limit) => {
        const beats = []
        let ticks = Math.round(start * 24)
        for (let i = 0; i < count; i++) {
            beats.push(beatOf(ticks))
            ticks += pick(steps)
        }
        // Spread the run over the chart rather than bunching it at the start.
        const scale = limit / (beats.at(-1) - beats[0] || 1)
        return beats.map((beat) => beatOf(Math.round((beats[0] + (beat - beats[0]) * scale) * 24)))
    }
    const strictly = (beats) => {
        const result = []
        for (const beat of beats)
            result.push(result.length && beat <= result.at(-1) ? result.at(-1) + 1 / 24 : beat)
        return result
    }

    const entities = []

    // Initialization is the first entity; its camera ref is filled below.
    const camera = chain(
        'CameraChange',
        strictly(ascending(485, 33, [3, 3, 15, 18, 6, 24, 3, 12], endBeat - 33)),
        (beat, i) => {
            const small = i % 3 === 1
            const zooms = i > 0 && i % 41 === 0 ? pick([0.8, 1.2, 1.5, 0.5]) : 1
            return [
                datum('#BEAT', beat),
                datum('lane', i > 0 && i % 97 === 0 ? pick([-1, 1, 2.5]) : 0),
                datum('size', small ? 5.75 : 6),
                datum('zoom', zooms),
                datum('zoomTargetLane', 0),
                datum('zoomTargetY', 0),
                datum('zoomVerticalAlign', 0),
                datum('rotate', i > 0 && i % 53 === 0 ? pick([5, -5, 15]) : 0),
                datum('stageTilt', i % 31 === 0 ? 0 : 1),
                datum('ease', pick([2, 2, 3, 3, 0, 1])),
            ]
        },
    )
    entities.push(
        entity('Initialization', [
            datum('initialLife', 1000),
            datum('revision', 2),
            ref('firstCamera', camera.first),
        ]),
    )

    // 15 tempo changes, the first at beat 0.
    const bpmBeats = [0, ...ascending(14, 20, [24, 48, 72, 96], endBeat - 40)]
    const tempos = [
        135, 131, 134.800003, 139, 134.800003, 135, 130, 135, 131, 135, 128, 135, 128, 135, 134,
    ]
    bpmBeats.forEach((beat, i) =>
        entities.push(entity('#BPM_CHANGE', [datum('#BEAT', beat), datum('#BPM', tempos[i])])),
    )

    // Time scale changes: one chain per group.
    const timeScaleCounts = [30, 40, 96, 30, 40, 22]
    const timeScales = groups.map((group, i) => {
        const beats = strictly(
            ascending(timeScaleCounts[i], 8.125, [3, 3, 6, 12, 24], endBeat - 12),
        )
        return chain('#TIMESCALE_CHANGE', beats, (beat, j) => {
            const hidden = j % 2 === 1
            return [
                ref('#TIMESCALE_GROUP', group.name),
                datum('#BEAT', beat),
                datum('editorLane', -6),
                datum('#TIMESCALE', j === 0 ? 1 : pick([0, 0.5, 1, 1, 2, 12, -1])),
                datum('#TIMESCALE_SKIP', hidden ? 0 : pick([0, 100])),
                datum('#TIMESCALE_EASE', pick([0, 0, 1, 1, 2, 3])),
                datum('transitionStyle', i === 2 && j % 5 === 0 ? 1 : 0),
                datum('hideNotes', 0),
            ]
        })
    })

    for (const group of groups) {
        const data = [ref('editorName', group.editorName)]
        if (group.forceNoteSpeed) data.push(datum('forceNoteSpeed', group.forceNoteSpeed))
        data.push(ref('first', timeScales[groups.indexOf(group)].first))
        entities.push(entity('#TIMESCALE_GROUP', data, group.name))
    }

    // Stage events: a chain per stage and kind, split from the totals below.
    const split = (total, index) => Math.floor(total / 4) + (index < total % 4 ? 1 : 0)
    const stageEvents = (archetype, total, make) =>
        stages.map((stage, i) => {
            const count = split(total, i)
            const beats = strictly([
                0,
                ...ascending(count - 1, 30 + i * 3, [48, 72, 96, 144, 36], endBeat - 60),
            ])
            return chain(archetype, beats, (beat, j) => make(beat, j, i))
        })
    const masks = stageEvents('StageMaskChange', 22, (beat, j, i) => [
        datum('#BEAT', beat),
        datum('lane', j === 0 ? 0 : pick([-2, 0, 1, 2.5])),
        datum('size', j === 0 ? 2 : pick([2, 3, 4, 6])),
        datum('maskNotes', (j + i) % 2),
        datum('ease', pick([1, 2, 3])),
    ])
    // The last stage has no pivot event.
    const pivots = stages.map((_, i) =>
        i === 3
            ? undefined
            : chain('StagePivotChange', [0], () => [
                  datum('#BEAT', 0),
                  datum('lane', 0),
                  datum('divisionSize', 2),
                  datum('divisionParity', i % 2),
                  datum('yOffset', 0),
                  datum('yBeatOffset', 0),
                  datum('ease', 1),
              ]),
    )
    const styles = stageEvents('StageStyleChange', 32, (beat, j) => [
        datum('#BEAT', beat),
        datum('editorLane', 0),
        datum('judgeLineColor', j === 0 ? 5 : int(8)),
        datum('judgeLineStyle', j % 4 === 3 ? 1 : 0),
        datum('leftBorderStyle', j === 0 ? 0 : int(4)),
        datum('rightBorderStyle', j === 0 ? 0 : int(4)),
        datum('fullWidth', 0),
        datum('noteAlpha', 1),
        datum('laneAlpha', pick([1, 1, 0.5])),
        datum('judgeLineAlpha', 1),
        datum('divisionLineAlpha', 1),
        datum('ease', j === 0 ? 0 : pick([0, 2, 3])),
    ])
    const transforms = stageEvents('StageTransformChange', 52, (beat, j, i) => [
        datum('#BEAT', beat),
        datum('rotate', j === 0 ? 0 : pick([0, 0, 15, -15, 90])),
        datum('xLaneTranslate', j === 0 ? 0 : pick([0, 0, 2, -2, 4])),
        datum('yLaneTranslate', j === 0 ? 0 : pick([0, 0, 1, -1])),
        datum('elevation', j === 0 ? 0 : pick([0, 0, 0.5, 1])),
        datum('anchor', i % 2),
        datum('ease', j === 0 ? 0 : pick([0, 2, 3])),
    ])

    stages.forEach((stage, i) => {
        const data = [
            ref('editorName', stage.editorName),
            datum('fromStart', i === 0 ? 1 : 0),
            datum('untilEnd', i === 0 ? 1 : 0),
            datum('generateSimLines', 0),
            ref('firstMaskChange', masks[i].first),
        ]
        if (pivots[i]) data.push(ref('firstPivotChange', pivots[i].first))
        data.push(
            ref('firstStyleChange', styles[i].first),
            ref('firstTransformChange', transforms[i].first),
        )
        entities.push(entity('Stage', data, stage.name))
    })

    for (const events of [camera, ...masks, ...pivots.filter(Boolean), ...styles, ...transforms]) {
        entities.push(...events.entities)
    }
    for (const events of timeScales) entities.push(...events.entities)

    // Notes.
    const flickDirection = (kind) => (kind.includes('Flick') ? pick([0, 1, 2]) : 0)
    const note = (archetype, props, extra = []) => {
        const data = [
            ref('#TIMESCALE_GROUP', props.group.name),
            ref('stage', props.stage.name),
            datum('#BEAT', props.beat),
            datum('lane', props.lane),
            datum('size', props.size),
            datum('direction', props.direction ?? flickDirection(archetype)),
            datum('isAttached', props.isAttached ?? 0),
            datum('isSeparator', props.isSeparator ?? 0),
            datum('connectorEase', props.ease ?? 1),
            datum('segmentKind', props.kind ?? (archetype.startsWith('Critical') ? 2 : 1)),
            datum('segmentAlpha', props.alpha ?? 1),
            datum('segmentLayer', props.layer ?? 0),
            datum('effectKind', props.effect ?? 0),
            datum('segmentThroughJudgeLine', 0),
            datum('segmentPresentation', 0),
            ...extra,
        ]
        return entity(archetype, data, props.name)
    }
    const sizes = [0.5, 1, 1, 1.25, 1.5, 2, 2.5]

    // Single notes, some in pairs joined by a sim line.
    const kinds = shuffle([
        ...Array(350).fill('NormalTapNote'),
        ...Array(115).fill('CriticalTapNote'),
        ...Array(137).fill('NormalFlickNote'),
        ...Array(16).fill('CriticalFlickNote'),
        ...Array(125).fill('NormalTraceNote'),
        ...Array(12).fill('CriticalTraceNote'),
    ])
    const simLines = []
    let ticks = 8 * 24
    const stepTicks = [6, 12, 12, 24, 24, 30, 8, 24, 36]
    for (let i = 0; i < kinds.length;) {
        const beat = beatOf(ticks)
        ticks += pick(stepTicks)
        const group = pickGroup()
        const stage = pickStage()
        const pair = i + 1 < kinds.length && simLines.length < 285 && chance(0.6)
        if (!pair) {
            const kind = kinds[i++]
            entities.push(
                note(kind, {
                    group,
                    stage,
                    beat,
                    lane: quarter(-5.5, 5.5),
                    size: pick(sizes),
                    effect: kind === 'NormalTapNote' && chance(0.02) ? 2 : 0,
                }),
            )
            continue
        }
        const sizeA = pick(sizes)
        const sizeB = pick(sizes)
        const laneA = quarter(-6, 0)
        const laneB = laneA + sizeA + sizeB + pick([0.5, 1, 2, 3])
        const names = [newName(), newName()]
        for (const [k, lane, size] of [
            [0, laneA, sizeA],
            [1, laneB, sizeB],
        ]) {
            entities.push(note(kinds[i++], { group, stage, beat, lane, size, name: names[k] }))
        }
        simLines.push(entity('SimLine', [ref('left', names[0]), ref('right', names[1])]))
    }

    // Holds: a head, interior notes and a tail, joined by active connectors.
    const tails = shuffle([
        ...Array(28).fill('NormalTailFlickNote'),
        ...Array(36).fill('NormalTailReleaseNote'),
        ...Array(22).fill('NormalTailTraceNote'),
    ])
    const holdSpecs = [
        ...Array(4).fill({ head: 'CriticalHeadTapNote', tail: 'CriticalTailReleaseNote' }),
        ...Array(5).fill({ head: 'NormalHeadTraceNote', tail: undefined }),
        ...Array(81).fill({ head: 'NormalHeadTapNote', tail: undefined }),
    ]
    shuffle(holdSpecs)
    holdSpecs.forEach((spec, h) => {
        const tail = spec.tail ?? tails.pop()
        const group = pickGroup()
        const stage = pickStage()
        const critical = spec.head.startsWith('Critical')
        const interior = pick([0, 0, 1, 1, 1, 2, 3])
        const start = 12 * 24 + int(Math.round((endBeat - 30) * 24))
        const length = (interior + 1) * pick([6, 12, 12, 18])
        const lane0 = quarter(-5, 5)
        const hold = {
            group,
            stage,
            kind: critical ? 2 : 1,
            ease: pick([1, 1, 1, 3, 2]),
        }
        const names = Array.from({ length: interior + 2 }, newName)
        const notes = names.map((name, j) => {
            const last = j === names.length - 1
            const first = j === 0
            const props = {
                ...hold,
                name,
                beat: beatOf(start + Math.round((length * j) / (names.length - 1))),
                lane: lane0 + (j % 2 ? 1 : 0) + j * 0.25,
                size: first || last ? pick(sizes) : 2,
            }
            const extra = last ? [ref('activeHead', names[0])] : [ref('next', names[j + 1])]
            if (first) return note(spec.head, { ...props, effect: critical ? 6 : 0 }, extra)
            if (last) return note(tail, props, extra)
            return chance(0.45)
                ? note(critical ? 'CriticalTraceNote' : 'NormalTraceNote', props, extra)
                : note('AnchorNote', { ...props, direction: 0 }, extra)
        })
        entities.push(...notes)
        for (let j = 0; j < names.length - 1; j++) {
            entities.push(
                entity('Connector', [
                    ref('head', names[j]),
                    ref('tail', names[j + 1]),
                    ref('segmentHead', names[j]),
                    ref('segmentTail', names[j + 1]),
                    ref('activeHead', names[0]),
                    ref('activeTail', names.at(-1)),
                ]),
            )
            if (h < 64 && j === 0) {
                entities.push(
                    entity('TransientHiddenTickNote', [
                        datum('#BEAT', (notes[0].data[2].value + notes[1].data[2].value) / 2),
                        datum('isAttached', 1),
                        ref('attachHead', names[0]),
                        ref('attachTail', names[1]),
                    ]),
                )
            }
        }
    })

    // Guides: chains of anchors, a few with an attached middle note.
    const guideLengths = shuffle([
        ...Array(150).fill(2),
        ...Array(37).fill(3),
        ...Array(9).fill(4),
        ...Array(16).fill(6),
        ...Array(2).fill(7),
        ...Array(2).fill(8),
        28,
        42,
    ])
    const stage3 = stages[3]
    let attachedLeft = 4
    guideLengths.forEach((length, g) => {
        const group = pickGroup()
        const attached = length === 3 && attachedLeft > 0 && chance(0.2)
        const stage = attached ? stage3 : pickStage()
        if (attached) attachedLeft--
        const kind = weighted([
            [101, 245],
            [102, 132],
            [103, 38],
            [105, 75],
            [108, 60],
        ])
        const alpha = weighted([
            [0, 210],
            [0.3, 160],
            [1, 190],
            [2, 93],
            [1.5, 24],
        ])
        const layer = weighted([
            [0, 100],
            [3, 100],
            [2, 2],
        ])
        const ease = weighted([
            [1, 20],
            [3, 77],
            [2, 32],
            [0, 12],
            [4, 9],
        ])
        const names = Array.from({ length }, newName)
        const start = int(Math.round((endBeat - 45) * 4)) / 4 + 1
        const lane0 = quarter(-7, 8.5)
        let beat = start
        names.forEach((name, j) => {
            const props = {
                group,
                stage,
                name,
                kind,
                alpha,
                layer,
                ease,
                beat,
                lane: lane0 + Math.sin(g + j) * 1.5,
                size: pick([0.25, 0.5, 0.5, 2]),
                direction: 0,
            }
            beat += pick([0.25, 0.5, 0.75, 1, 1.5])
            const extra = []
            if (j < length - 1) extra.push(ref('next', names[j + 1]))
            if (attached && j === 1) {
                extra.push(ref('attachHead', names[0]), ref('attachTail', names[2]))
                entities.push(
                    note(
                        'AnchorNote',
                        { ...props, isAttached: 1, isSeparator: 1, alpha: 0, kind: 103 },
                        extra,
                    ),
                )
                return
            }
            entities.push(note('AnchorNote', props, extra))
        })
        for (let j = 0; j < length - 1; j++) {
            entities.push(
                entity('Connector', [
                    ref('head', names[j]),
                    ref('tail', names[j + 1]),
                    ref('segmentHead', names[j]),
                    ref('segmentTail', names[j + 1]),
                ]),
            )
        }
    })

    entities.push(...simLines)

    return `${JSON.stringify({ bgmOffset: -0.249, entities })}\n`
}

export const outputPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'tests',
    'fixtures',
    'generated-large.json',
)

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const text = generateLargeChart()
    if (process.argv.includes('--stdout')) process.stdout.write(text)
    else {
        writeFileSync(outputPath, text)
        console.log(`Wrote ${outputPath} (${text.length} bytes)`)
    }
}
