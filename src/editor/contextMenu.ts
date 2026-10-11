import { shallowRef } from 'vue'
import { state } from '../history'
import { selectedEntities } from '../history/selectedEntities'
import { settings } from '../settings'
import { beatToTime } from '../state/integrals/bpms'
import { deselect } from './commands/deselect'
import { getComposedLayout } from './composedView'
import { editorNavigation } from './navigation'
import { select } from './tools/select'
import { getLaneAnchor, pointHitsAt, selectedHit } from './tools/utils'
import { view } from './view'

export const contextMenu = shallowRef<{ x: number; y: number; selection?: boolean }>()

export const closeContextMenu = () => {
    contextMenu.value = undefined
}

export const openContextMenu = (x: number, y: number) => {
    const found = pointHitsAt(x, y)
    const { hits } = found
    if (!hits.length && selectedEntities.value.length) {
        closeContextMenu()
        void deselect.execute()
        return
    }
    if (!selectedEntities.value.length || (hits.length && !selectedHit(found))) {
        if (editorNavigation.value) editorNavigation.value.selectPoint(x, y)
        else void select.tap?.(x, y, { ctrl: false, shift: false })
    }
    contextMenu.value = { x, y }
}

export const openSelectionContextMenu = () => {
    const point = editorNavigation.value?.getContextMenuPoint?.()
    if (point) {
        contextMenu.value = { ...point, selection: true }
        return
    }
    const entity = selectedEntities.value[0]
    // Notes open where drawn; Paste reads the menu's x as a displayed lane.
    const note =
        entity?.type === 'note' ? (getComposedLayout()?.notePosition(entity) ?? entity) : undefined
    const lane = note ? note.left : entity ? (getLaneAnchor(entity) ?? 6.5) : undefined
    const size = note
        ? note.size
        : entity?.type === 'cameraEventJoint'
          ? entity.cameraSize
          : entity?.type === 'stageMaskEventJoint'
            ? entity.maskSize
            : 0
    const x =
        lane === undefined
            ? view.pointer.x > view.x && view.pointer.x < view.x + view.w
                ? view.pointer.x
                : view.x + view.w / 2
            : view.x + view.w * (0.5 + (lane + size / 2 - view.lane) / settings.width)
    const time = entity ? beatToTime(state.value.bpms, entity.beat) : view.cursorTime
    contextMenu.value = {
        x,
        y: view.y + view.h / 2 - (time - view.time) * settings.pps,
        selection: true,
    }
}
