// The control recipes in src/controls.css, as a plugin for every Tailwind build (docs/color-system.md).
// That way templates, global CSS, the landing pages and Vue <style> blocks (@apply ghost) can all use them.
const { readFileSync } = require('node:fs')
const postcss = require('postcss')
const plugin = require('tailwindcss/plugin')

// Tailwind finds a config's dependencies by scanning its files' text for require('...') calls, and builds
// every stylesheet again when one changes. controls.css is read with readFileSync below, so it needs a
// line Tailwind can see, or a running dev server keeps the recipes it started with. This is only text to
// Tailwind and the file is never loaded: require('./src/controls.css')

module.exports = plugin(({ addComponents }) => {
    const root = postcss.parse(readFileSync(require.resolve('./src/controls.css'), 'utf8'))
    const rules = []
    root.walkAtRules('layer', (layer) => rules.push(...layer.nodes.map((node) => node.clone())))
    addComponents(rules)
})
