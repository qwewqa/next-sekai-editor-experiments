import type { Command } from '..'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import { settings } from '../../../settings'
import { interpolate } from '../../../utils/interpolate'
import { notify } from '../../notification'
import CustomLaneLimitModal from './CustomLaneLimitModal.vue'
import LaneLimitIcon from './LaneLimitIcon.vue'

const setLimit = (maxLane: number) => {
    // The mouse controls refresh a hover ghost under a still mouse.
    settings.maxLane = maxLane
    notify(
        maxLane
            ? interpolate(() => i18n.value.commands.laneLimits.limited, `${maxLane}`)
            : () => i18n.value.commands.laneLimits.unlimited,
    )
}

export const laneLimitNone: Command = {
    title: () => i18n.value.commands.laneLimits.none,
    icon: { is: LaneLimitIcon, props: { mode: 'none' } },
    execute() {
        setLimit(0)
    },
}

export const laneLimitSix: Command = {
    title: () => i18n.value.commands.laneLimits.six,
    icon: { is: LaneLimitIcon, props: { mode: 'six' } },
    execute() {
        setLimit(6)
    },
}

export const laneLimitCustom: Command = {
    title: () => i18n.value.commands.laneLimits.custom,
    icon: { is: LaneLimitIcon, props: { mode: 'custom' } },
    async execute() {
        const maxLane: number | undefined = await showModal(CustomLaneLimitModal, {})
        if (maxLane === undefined || !Number.isFinite(maxLane) || maxLane <= 0) return
        settings.customMaxLane = maxLane
        setLimit(maxLane)
    },
}
