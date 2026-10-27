import type { Command } from '..'
import { i18n } from '../../../i18n'
import { isBgmEnabled } from '../../../player'
import { interpolate } from '../../../utils/interpolate'
import { notify } from '../../notification'
import ToggleVolumeIcon from './ToggleVolumeIcon.vue'

export const toggleBgmVolume: Command = {
    title: interpolate(
        () => i18n.value.commands.toggleVolume.title,
        () => i18n.value.commands.toggleVolume.type.bgm,
    ),
    icon: {
        is: ToggleVolumeIcon,
        props: {
            get state() {
                return isBgmEnabled.value
            },
        },
    },

    readOnly: true,

    execute() {
        const enabled = !isBgmEnabled.value
        isBgmEnabled.value = enabled

        notify(
            interpolate(
                () =>
                    enabled
                        ? i18n.value.commands.toggleVolume.unmuted
                        : i18n.value.commands.toggleVolume.muted,
                () => i18n.value.commands.toggleVolume.type.bgm,
            ),
        )
    },
}
