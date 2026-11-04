import type { Plugin } from 'vite'

export function entryStylesheetFirst(html: string, entryFiles: readonly string[]): string

export function entryStylesheetPlugin(): Plugin

export function entryStylesheetProblem(html: string): string | undefined
