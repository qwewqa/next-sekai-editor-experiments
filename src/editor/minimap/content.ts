// The minimap's content layer in a component's setup (design §3.2): the identity watchers that
// feed the pipeline, the canvas's size and the device pixel ratio. Everything stops with the scope.

import { shallowRef, watch, type Ref } from 'vue'
import { isPeeking, liveState, state } from '../../history'
import { view } from '../view'
import type { MinimapMapping } from './mapping'
import { createMinimapPipeline, type MinimapPipeline } from './pipeline'

export const useMinimapContent = (canvas: Readonly<Ref<HTMLCanvasElement | null | undefined>>) => {
    const mapping = shallowRef<MinimapMapping>()
    let pipeline: MinimapPipeline | undefined

    const push = () => {
        pipeline?.setSources({
            shown: state.value,
            live: liveState.value,
            peeking: isPeeking.value,
        })
    }

    // Identities only: no deep watch, and none on the state itself. A selection change touches
    // none of these. The layout resolves in the pass, not here.
    watch(
        [
            () => state.value.store.grid.note,
            () => state.value.store.grid.connector,
            () => state.value.bpms,
            () => view.layout,
            () => state.value.isDynamicStages,
            () => state.value.stages,
            () => state.value.store.grid.stageMaskEventJoint,
            () => state.value.store.grid.stagePivotEventJoint,
            () => state.value.store.grid.stageStyleEventJoint,
            () => state.value.store.grid.stageTransformEventJoint,
            () => liveState.value.store.grid.note,
            () => liveState.value.bpms,
            isPeeking,
        ],
        push,
    )

    watch(
        canvas,
        (element, _, onCleanup) => {
            if (!element) return
            const created = createMinimapPipeline(element)
            pipeline = created
            const stopMapping = watch(created.mapping, (next) => (mapping.value = next), {
                flush: 'sync',
            })

            let width = 0
            let height = 0
            const setGeometry = () =>
                created.setGeometry(width, height, window.devicePixelRatio || 1)
            const observer = new ResizeObserver((entries) => {
                const box = entries.at(-1)?.contentRect
                if (!box) return
                width = box.width
                height = box.height
                setGeometry()
            })
            observer.observe(element)

            // The ratio changes with the zoom level or a move to another display.
            let query: MediaQueryList | undefined
            const updateRatio = () => {
                query?.removeEventListener('change', updateRatio)
                query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
                query.addEventListener('change', updateRatio)
                setGeometry()
            }
            updateRatio()

            push()
            onCleanup(() => {
                observer.disconnect()
                query?.removeEventListener('change', updateRatio)
                stopMapping()
                created.dispose()
                if (pipeline === created) pipeline = undefined
                mapping.value = undefined
            })
        },
        { immediate: true, flush: 'post' },
    )

    return { mapping }
}
