import assert from 'node:assert/strict'
import { test } from 'node:test'
import { helpTargetFor } from '../../src/editor/help/target'
import type { ToolName } from '../../src/editor/tools'

const tools: ToolName[] = [
    'select',
    'eraser',
    'brush',
    'paste',
    'note',
    'slide',
    'generateSlideNotes',
    'bpm',
    'timeScale',
    'cameraEvent',
    'stageMaskEvent',
    'stagePivotEvent',
    'stageStyleEvent',
    'stageTransformEvent',
    'offset',
]

const at = (tool: ToolName, peeking = false, elevationFull = false) =>
    helpTargetFor({ peeking, elevationFull, tool })

test('peeking opens History, even with the Elevation Editor full', () => {
    assert.equal(at('note', true), 'history')
    assert.equal(at('note', true, true), 'history')
})

test('the Elevation Editor filling the chart opens its entry', () => {
    assert.equal(at('note', false, true), 'elevation')
})

test('a tool opens its own entry, and the event tools open Events', () => {
    for (const tool of tools) {
        const expected = tool.endsWith('Event') ? 'events' : tool
        assert.equal(at(tool), expected)
    }
})
