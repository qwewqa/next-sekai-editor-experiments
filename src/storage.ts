import { name } from '../package.json'

/** The localStorage key the app stores a key under. */
export const storageKey = (key: string) => `${name}.${key}`

export const storageGet = (key: string, defaultValue: unknown): unknown => {
    try {
        const value = localStorage.getItem(storageKey(key))
        if (value === null) return defaultValue

        return JSON.parse(value)
    } catch {
        return defaultValue
    }
}

export const storageSet = (key: string, value: unknown) => {
    localStorage.setItem(storageKey(key), JSON.stringify(value))
}

export const storageRemove = (key: string) => {
    localStorage.removeItem(storageKey(key))
}
