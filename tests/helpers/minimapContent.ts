// Mounts the minimap's content hook outside a component, with the app's own Vue instance.
import { effectScope, shallowRef } from 'vue'
import { useMinimapContent } from '../../src/editor/minimap/content'

export const mountMinimapContent = (canvas: HTMLCanvasElement) => {
    const scope = effectScope()
    const element = shallowRef<HTMLCanvasElement | null>(canvas)
    const content = scope.run(() => useMinimapContent(element))
    if (!content) throw new Error('The scope did not run')
    return {
        mapping: content.mapping,
        /** Like the strip leaving the page: the canvas ref clears, then the scope stops. */
        unmount() {
            element.value = null
            scope.stop()
        },
    }
}
