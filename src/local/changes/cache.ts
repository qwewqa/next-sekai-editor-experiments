// A small LRU for the change view's worker caches: everything is keyed by
// content (a hash, or a pair of roots), so nothing goes stale; old entries just leave.

export class Lru<K, V> {
    private readonly map = new Map<K, V>()

    constructor(private readonly limit: number) {}

    get(key: K): V | undefined {
        const value = this.map.get(key)
        if (value === undefined) return
        this.map.delete(key)
        this.map.set(key, value)
        return value
    }

    set(key: K, value: V) {
        this.map.delete(key)
        this.map.set(key, value)
        for (const old of this.map.keys()) {
            if (this.map.size <= this.limit) break
            this.map.delete(old)
        }
    }

    clear() {
        this.map.clear()
    }

    get size() {
        return this.map.size
    }
}
