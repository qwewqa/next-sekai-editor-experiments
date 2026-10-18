import type { Plugin } from 'vite'

export function samplesDir(root: string, env?: Record<string, string | undefined>): string | undefined

export function samplesPlugin(root: string): Plugin

export function probePlugin(root: string): Plugin
