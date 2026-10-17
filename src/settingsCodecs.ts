import Type from 'typebox'

/** Command names as stored: names not registered yet are kept, and use sites filter. */
export const storedNames = () =>
    Type.Codec(Type.Array(Type.String()))
        .Decode((values) => values)
        .Encode((values) => values)

/** Bindings by command name as stored: names not registered yet are kept. */
export const storedBindings = (defaults: Record<string, string>) =>
    Type.Codec(Type.Record(Type.String(), Type.String(), { default: defaults }))
        .Decode((value) => value)
        .Encode((values) => values)
