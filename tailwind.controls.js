// The control recipes in src/controls.css, as a plugin for every Tailwind build (docs/color-system.md).
// That way templates, global CSS, the landing pages and Vue <style> blocks (@apply ghost) can all use them.
const { readFileSync } = require('node:fs')
const postcss = require('postcss')
const plugin = require('tailwindcss/plugin')

module.exports = plugin(({ addComponents }) => {
    const root = postcss.parse(readFileSync(require.resolve('./src/controls.css'), 'utf8'))
    const rules = []
    root.walkAtRules('layer', (layer) => rules.push(...layer.nodes.map((node) => node.clone())))
    addComponents(rules)
})
