// Every unit test runs as it would on any machine: in UTC, in US English. The runner's child
// processes inherit the time zone, and take the language from this module, which Node passes on.
process.env.TZ = 'UTC'
Object.defineProperties(globalThis.navigator, {
    language: { value: 'en-US', configurable: true },
    languages: { value: ['en-US'], configurable: true },
})
