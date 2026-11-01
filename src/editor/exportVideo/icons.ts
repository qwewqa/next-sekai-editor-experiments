import { defineComponent, h } from 'vue'

// Set In and Set Out: stroked pictograms of a bracket at the playhead.
const bracket = (paths: string[]) =>
    defineComponent({
        setup: () => () =>
            h(
                'svg',
                {
                    viewBox: '0 0 16 16',
                    style: 'fill: none',
                    stroke: 'currentColor',
                    'stroke-width': 2,
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round',
                    'aria-hidden': 'true',
                },
                paths.map((d) => h('path', { d })),
            ),
    })

export const SetInIcon = bracket(['M7 2H3v12h4', 'M11 5v6'])
export const SetOutIcon = bracket(['M9 2h4v12H9', 'M5 5v6'])
