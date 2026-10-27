import { fileURLToPath } from 'node:url'
import { sourceRepository } from '../../scripts/repository.mjs'

/** The repository the build links to, from the resolver vite.config.ts uses. */
export const REPOSITORY = sourceRepository({
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
})
