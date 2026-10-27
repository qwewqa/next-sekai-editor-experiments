import type { Command } from '..'
import { i18n } from '../../../i18n'
import { isSfxEnabled } from '../../../player'
import { interpolate } from '../../../utils/interpolate'
import { notify } from '../../notification'
import ToggleVolumeIcon from './ToggleVolumeIcon.vue'

export const toggleSfxVolume: Command = {
    title: interpolate(
        () => i18n.value.commands.toggleVolume.title,
        () => i18n.value.commands.toggleVolume.type.sfx,
    ),
    icon: {
        is: ToggleVolumeIcon,
        props: {
            get state() {
                return isSfxEnabled.value
            },
        },
    },

    readOnly: true,

    execute() {
        const enabled = !isSfxEnabled.value
        isSfxEnabled.value = enabled

        notify(
            interpolate(
                () =>
                    enabled
                        ? i18n.value.commands.toggleVolume.unmuted
                        : i18n.value.commands.toggleVolume.muted,
                () => i18n.value.commands.toggleVolume.type.sfx,
            ),
        )
    },
}
