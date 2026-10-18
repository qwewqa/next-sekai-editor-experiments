import type { Plugin } from 'vite'

export function samplesDir(root: string, env?: Record<string, string | undefined>): string | undefined

export function samplesPlugin(root: string): Plugin
