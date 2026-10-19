import { ref } from 'vue'
import type { Tool } from '..'
import { pushState, state } from '../../../history'
import { bgm } from '../../../history/bgm'
import { i18n } from '../../../i18n'
import { align } from '../../../utils/math'
import { bgmOffsetOperation } from '../../headerLabels'
import { notify } from '../../notification'
import { yToTime } from '../../view'

export const bgmOffsetDelta = ref(0)

let activeTime = 0

export const offset: Tool = {
    title: () => i18n.value.tools.offset.title,

    cursor: () => 'ns-resize',

    dragStart(x, y) {
        activeTime = yToTime(y)

        bgmOffsetDelta.value = 0

        return true
    },

    dragUpdate(x, y) {
        bgmOffsetDelta.value = activeTime - yToTime(y)
    },

    dragEnd(x, y) {
        bgmOffsetDelta.value = 0

        // A drop back where it started keeps the offset exact.
        const delta = activeTime - yToTime(y)
        const offset = align(bgm.value.offset + delta, 1000)
        if (!delta || offset === bgm.value.offset) return

        const operation = bgmOffsetOperation(bgm.value.offset, offset)
        pushState(operation, {
            ...state.value,
            bgm: { ...bgm.value, offset },
        })

        notify(() => operation.fallback.text)
    },

    dragCancel() {
        bgmOffsetDelta.value = 0
    },
}
