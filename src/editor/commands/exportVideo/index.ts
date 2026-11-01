import type { Command } from '..'
import { i18n } from '../../../i18n'
import { loadForAction } from '../../loadFailure'
import { notify } from '../../notification'
import FilmIcon from './FilmIcon.vue'

// Export Video…: a video of the preview, of the chart on screen, peeks included.
export const exportVideo: Command = {
    readOnly: true,
    title: () => i18n.value.commands.exportVideo.title,
    icon: {
        is: FilmIcon,
    },

    async execute() {
        // A browser that cannot encode both video and sound, such as Safari before 26, has none.
        if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
            notify(() => i18n.value.exportVideo.unsupported)
            return
        }
        const loaded = await loadForAction(async () => ({
            open: await import('../../exportVideo/open'),
            env: await import('../../exportVideo/env'),
        }))
        if (!loaded) return
        await loaded.open.openExportVideo(
            loaded.env.pageEnv(
                () =>
                    new Worker(new URL('../../exportVideo/export.worker.ts', import.meta.url), {
                        type: 'module',
                        name: 'nse-export',
                    }),
            ),
        )
    },
}
