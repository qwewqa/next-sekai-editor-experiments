import { platform } from '../../../platform'
import { settings } from '../../../settings'
import { createServerClient } from './client'

/** The client the editor uses: the platform's fetch, and the interface language. */
export const createLiveServerClient = () =>
    createServerClient({
        fetch: (url, init) => platform.fetchServer(url, init),
        language: () => settings.locale,
    })
