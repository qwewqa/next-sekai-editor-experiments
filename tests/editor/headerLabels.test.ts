import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    bgmOffsetText,
    bgmText,
    groupEditText,
    initialLifeText,
    stageEditText,
} from '../../src/editor/headerLabelText'
import type en from '../../src/i18n/en/index.json'

type Messages = typeof en

const messages = (locale: string) =>
    JSON.parse(
        readFileSync(new URL(`../../src/i18n/${locale}/index.json`, import.meta.url), 'utf8'),
    ) as Messages
const m = messages('en')

const group = { name: 'Verse' }
const stage = {
    name: 'Main',
    isFromStart: false,
    isUntilEnd: false,
    generateSimLines: 'global' as const,
}

test('Initial Life and BGM offset labels carry the value', () => {
    assert.equal(initialLifeText(m, 'en', 1000), 'Set Initial Life to 1,000')
    assert.equal(bgmOffsetText(m, 'en', 0.15), 'Set BGM Offset to 0.15 s')
    assert.equal(bgmOffsetText(m, 'en', -0.0125), 'Set BGM Offset to -0.0125 s')
    assert.equal(
        bgmOffsetText(messages('fr'), 'fr', 0.15),
        'Décalage de la musique défini sur 0,15 s',
    )
    assert.equal(initialLifeText(messages('ja'), 'ja', 1000), '初期ライフを1,000に設定しました')
})

test('a BGM change names the file, the offset or both', () => {
    const old = { buffer: {}, filename: 'a.mp3', offset: 0 }
    assert.equal(bgmText(m, 'en', old, { ...old, filename: 'b.mp3' }), 'Changed BGM File')
    assert.equal(bgmText(m, 'en', old, { ...old, buffer: {} }), 'Changed BGM File')
    assert.equal(bgmText(m, 'en', old, { ...old, offset: 0.15 }), 'Set BGM Offset to 0.15 s')
    assert.equal(bgmText(m, 'en', old, { buffer: {}, filename: 'b.mp3', offset: 1 }), 'Changed BGM')
})

test('group edits name the field and its new value', () => {
    assert.equal(groupEditText(m, 'en', group, 'name', 'Chorus'), 'Renamed Verse group to Chorus')
    assert.equal(
        groupEditText(m, 'en', group, 'forceNoteSpeed', 8.5),
        'Set Force Note Speed of Verse group to 8.5',
    )
    assert.equal(
        groupEditText(m, 'en', group, 'forceNoteSpeed', undefined),
        'Cleared Force Note Speed of Verse group',
    )
})

test('stage edits name the field and its new value', () => {
    assert.equal(stageEditText(m, stage, 'name', 'Side'), 'Renamed Main stage to Side')
    assert.equal(
        stageEditText(m, stage, 'isFromStart', true),
        'Set From Start of Main stage to Enabled',
    )
    assert.equal(
        stageEditText(m, stage, 'isUntilEnd', false),
        'Set Until End of Main stage to Disabled',
    )
    assert.equal(
        stageEditText(m, stage, 'generateSimLines', 'isolated'),
        'Set Generate Sim Lines of Main stage to Isolated',
    )
})

test('every locale fills the new labels', () => {
    for (const locale of ['en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht']) {
        const l = messages(locale)
        for (const text of [
            initialLifeText(l, locale, 1000),
            bgmOffsetText(l, locale, 0.15),
            groupEditText(l, locale, group, 'forceNoteSpeed', 8),
            groupEditText(l, locale, group, 'forceNoteSpeed', undefined),
            stageEditText(l, stage, 'isFromStart', true),
        ]) {
            assert.ok(text && !/\{\d\}|undefined/.test(text), `${locale}: ${text}`)
        }
    }
})
