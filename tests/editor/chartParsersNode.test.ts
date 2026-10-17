import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { setDefaultGroupName } from '../../src/chart/groups'
import { parseLevelDataChart } from '../../src/chart/parse/levelData'
import { parseSusChart } from '../../src/chart/parse/sus'
import { parseUscChart } from '../../src/chart/parse/usc'
import { chcyToUsc, isChcyLevelData } from '../../src/chcy/convert'
import en from '../../src/i18n/en/index.json'
import { parseLevelData } from '../../src/levelData/parse'
import { parseSus } from '../../src/sus/parse'
import { parseUsc } from '../../src/usc/parse'
import { minimalLevel } from './levelDataSynthetic'

// This file is the proof that the chart parsers load in Node: nothing here stubs a module.

const chcy = {
    bgmOffset: 0.5,
    entities: [
        { archetype: 'Initialization', data: [] },
        { archetype: 'InputManager', data: [] },
        { archetype: 'Stage', data: [] },
        {
            name: 'tsg:0',
            archetype: 'TimeScaleGroup',
            data: [
                { name: 'first', ref: 'tsc:0:0' },
                { name: 'length', value: 0 },
                { name: 'next', value: -1 },
            ],
        },
        {
            archetype: '#BPM_CHANGE',
            data: [
                { name: '#BEAT', value: 0 },
                { name: '#BPM', value: 150 },
            ],
        },
        {
            archetype: 'CriticalTapNote',
            data: [
                { name: '#BEAT', value: 1 },
                { name: 'lane', value: -2 },
                { name: 'size', value: 1.5 },
                { name: 'timeScaleGroup', ref: 'tsg:0' },
            ],
        },
    ],
}

const usc = {
    version: 2,
    usc: {
        offset: -0.25,
        objects: [
            { type: 'bpm', beat: 0, bpm: 120 },
            { type: 'timeScaleGroup', changes: [{ beat: 0, timeScale: 1 }] },
            {
                type: 'single',
                beat: 1,
                timeScaleGroup: 0,
                lane: 0,
                size: 1,
                critical: false,
                trace: false,
            },
        ],
    },
}

const sus = [
    '#TITLE "Import"',
    '#ARTIST "Test"',
    '#DESIGNER "Test"',
    '#DIFFICULTY 0',
    '#PLAYLEVEL 1',
    '#SONGID "import"',
    '#WAVE "import.mp3"',
    '#WAVEOFFSET 0',
    '#REQUEST "ticks_per_beat 480"',
    '#00002:4',
    '#BPM01:120',
    '#00008:01',
    '#00112:11',
    '#00113:11',
]

const groupNames = (chart: { groups: Map<unknown, { name: string }> }) =>
    [...chart.groups.values()].map(({ name }) => name)

test('the level data, USC, SUS and ChCy parsers run in Node', () => {
    const levelData = parseLevelDataChart(minimalLevel())
    assert.equal(levelData.slides.length, 1)

    const fromUsc = parseUscChart(parseUsc(usc).usc.objects)
    assert.equal(fromUsc.slides.length, 1)

    const fromSus = parseSusChart(parseSus(sus))
    assert.ok(fromSus.slides.length > 0)

    const data = parseLevelData(chcy)
    assert.ok(isChcyLevelData(data))
    assert.equal(parseUscChart(chcyToUsc(data).objects).slides.length, 1)
})

test('a group made without a name is named in English until a language is set', () => {
    const name = () => groupNames(parseUscChart(parseUsc(usc).usc.objects))[0]
    assert.equal(name(), en.group.default)

    setDefaultGroupName(() => 'Standard')
    try {
        assert.equal(name(), 'Standard')
    } finally {
        setDefaultGroupName(() => en.group.default)
    }
    assert.equal(name(), en.group.default)
})

const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : []
    })

test('the chart parsers do not import the language module or a component', () => {
    const dirs = ['chart', 'levelData', 'usc', 'sus', 'chcy'].map((dir) => join('src', dir))
    for (const file of dirs.flatMap(sources)) {
        const specifiers = [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map(
            (match) => match[1] ?? '',
        )
        for (const specifier of specifiers) {
            assert.ok(!specifier.endsWith('.vue'), `${file} imports ${specifier}`)
            assert.ok(
                !/(^|\/)(i18n|settings)(\/index)?(\.ts)?$/.test(specifier),
                `${file} imports ${specifier}`,
            )
        }
    }
})
