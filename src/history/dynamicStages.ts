import { computed } from 'vue'
import { createAsyncEditGuard } from '../editor/asyncEditGuard'
import { notify } from '../editor/notification.ts'
import { i18n } from '../i18n/index.ts'
import ConfirmModal from '../modals/ConfirmModal.vue'
import { showModal } from '../modals/index.ts'
import type { Entity } from '../state/entities'
import { addStageMaskEventJoint } from '../state/mutations/events/stage/mask'
import { addStagePivotEventJoint } from '../state/mutations/events/stage/pivot'
import { addStageStyleEventJoint } from '../state/mutations/events/stage/style'
import { countNativeEntities } from '../state/operations/historyReceipts'
import { createTransaction } from '../state/transaction'
import { createHistoryOperation } from './createHistoryOperation'
import { isPeeking, pushState, state } from './index.ts'
import { refuseWhilePeeking } from './peek'
import { selectedEntities } from './selectedEntities'
import { defaultStageId } from './stages'

export const isDynamicStages = computed(() => state.value.isDynamicStages)

export type DynamicStagesOutcome = 'enabled' | 'declined' | 'stale'

export const requestDynamicStages = async (
    isCurrent: () => boolean = () => true,
): Promise<DynamicStagesOutcome> => {
    if (!isCurrent()) return 'stale'
    if (isDynamicStages.value) return 'enabled'
    // Enabling them is an edit, refused while peeking.
    if (isPeeking.value) {
        refuseWhilePeeking()
        return 'stale'
    }

    const guard = createAsyncEditGuard()
    try {
        const result = await showModal(ConfirmModal, {
            title: () => i18n.value.history.dynamicStages.title,
            message: () => i18n.value.history.dynamicStages.message,
            confirm: () => i18n.value.workspace.stages.enable,
        })
        if (!guard.isCurrent() || !isCurrent()) return 'stale'
        if (!result) return 'declined'

        const transaction = createTransaction(state.value)

        const created: Entity[] = addStageMaskEventJoint(transaction, {
            stageId: defaultStageId.value,
            beat: 0,
            maskLeft: -6,
            maskSize: 12,
            isMaskNotes: false,
            eventEase: 'linear',
        })
        created.push(
            ...addStagePivotEventJoint(transaction, {
                stageId: defaultStageId.value,
                beat: 0,
                pivotLane: 0,
                divisionSize: 2,
                divisionParity: 'even',
                yOffset: 0,
                yOffsetBeat: 0,
                eventEase: 'linear',
            }),
        )
        created.push(
            ...addStageStyleEventJoint(transaction, {
                stageId: defaultStageId.value,
                beat: 0,
                editorLane: 0,
                laneColor: 'default',
                judgmentLineColor: 'purple',
                judgmentLineStyle: 'default',
                leftBorderStyle: 'default',
                rightBorderStyle: 'default',
                isFullWidth: false,
                noteAlpha: 1,
                laneAlpha: 1,
                judgmentLineAlpha: 1,
                divisionLineAlpha: 1,
                eventEase: 'linear',
            }),
        )

        // The default stage events it adds, counted from what was added.
        pushState(
            createHistoryOperation({
                id: 'nse.dynamicStages.enable',
                data: { created: countNativeEntities(created) },
            }),
            {
                ...transaction.commit([...selectedEntities.value]),
                isDynamicStages: true,
            },
        )

        notify(() => i18n.value.history.dynamicStages.enabled)

        return 'enabled'
    } finally {
        guard.dispose()
    }
}

export const checkDynamicStages = async () => (await requestDynamicStages()) === 'enabled'
