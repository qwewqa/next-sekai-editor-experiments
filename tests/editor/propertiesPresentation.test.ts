import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultDockSize } from '../../src/editor/workspace/layout'
import {
    nextPropertiesSection,
    propertiesPresentation,
} from '../../src/editor/workspace/properties/presentation'

const propertiesSections = ['selection', 'tool', 'view'] as const

test('tall panels stack sections while short panels use section tabs', () => {
    // Desktop right dock below a toolbar.
    assert.equal(propertiesPresentation(960), 'sections')
    // Landscape phone side dock.
    assert.equal(propertiesPresentation(354), 'tabs')
    // Portrait phone and tablet top docks at their default heights.
    assert.equal(propertiesPresentation(defaultDockSize('top', 390, 844)), 'tabs')
    assert.equal(propertiesPresentation(defaultDockSize('top', 820, 1180)), 'tabs')
    // A side tile shared with another panel.
    assert.equal(propertiesPresentation(430), 'tabs')
    // A very narrow but tall tile stacks too.
    assert.equal(propertiesPresentation(900), 'sections')
})

test('resizing across the threshold keeps the current presentation within a band', () => {
    // Shrinking from sections switches only well below the threshold.
    assert.equal(propertiesPresentation(500, 'sections'), 'sections')
    assert.equal(propertiesPresentation(489, 'sections'), 'tabs')
    // Growing from tabs switches back only well above it.
    assert.equal(propertiesPresentation(540, 'tabs'), 'tabs')
    assert.equal(propertiesPresentation(550, 'tabs'), 'sections')
})

test('section tab keys wrap and jump to the ends', () => {
    assert.equal(nextPropertiesSection(propertiesSections, 'selection', 'ArrowLeft'), 'view')
    assert.equal(nextPropertiesSection(propertiesSections, 'view', 'ArrowRight'), 'selection')
    assert.equal(nextPropertiesSection(propertiesSections, 'tool', 'Home'), 'selection')
    assert.equal(nextPropertiesSection(propertiesSections, 'tool', 'End'), 'view')
    assert.equal(nextPropertiesSection(propertiesSections, 'tool', 'Enter'), undefined)
})
