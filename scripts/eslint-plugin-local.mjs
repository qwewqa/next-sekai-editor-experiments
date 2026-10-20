// The editor's own lint rules (Part 1 §1.6.8.7): History reads local time and formats dates only
// through the calendar module, the History clock and `historyFormat`. The rules work by name, not
// by type, so they are cheap and need no project. Where each rule applies, and its allowlist, is in
// eslint.config.js.

import path from 'node:path'

const normalized = (name) => name.replaceAll('\\', '/')

const LOCAL_DATE_MEMBERS = new Set([
    'getFullYear',
    'getYear',
    'getMonth',
    'getDate',
    'getDay',
    'getHours',
    'getMinutes',
    'getSeconds',
    'getMilliseconds',
    'setFullYear',
    'setYear',
    'setMonth',
    'setDate',
    'setHours',
    'setMinutes',
    'setSeconds',
    'setMilliseconds',
    'toDateString',
    'toTimeString',
    'toLocaleDateString',
    'toLocaleTimeString',
    'getTimezoneOffset',
])

/** The name a member expression reads: `.name`, `['name']` or a template without holes. */
const memberName = (node) => {
    if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : undefined
    const { property } = node
    if (property.type === 'Literal' && typeof property.value === 'string') return property.value
    if (property.type === 'TemplateLiteral' && property.expressions.length === 0)
        return property.quasis[0].value.cooked ?? undefined
    return undefined
}

const isDate = (node) => node.type === 'Identifier' && node.name === 'Date'

const noLocalTime = {
    meta: {
        type: 'problem',
        schema: [],
        messages: {
            local: '{{ name }} reads or writes local time. History takes days, hours and minutes from src/calendar/calendar.ts with the History clock’s zone.',
            construct:
                'new Date here must take one time in ms. Local dates come from src/calendar/calendar.ts.',
            parse: 'Date.parse reads local time. Parse a time where it comes in, not in History.',
            intl: 'Intl.DateTimeFormat formats in the engine’s zone. Format through historyFormat.',
            now: 'Date.now() belongs to calendarClock.ts. Read the History calendar; time an interval with performance.now().',
        },
    },
    create(context) {
        const file = normalized(context.filename)
        const inHistory = file.includes('/src/editor/history/')
        const mayReadNow = file.endsWith('/src/editor/history/calendarClock.ts')
        return {
            MemberExpression(node) {
                const name = memberName(node)
                if (name === undefined) return
                if (LOCAL_DATE_MEMBERS.has(name))
                    context.report({ node, messageId: 'local', data: { name } })
                else if (isDate(node.object) && name === 'parse')
                    context.report({ node, messageId: 'parse' })
                else if (name === 'DateTimeFormat') context.report({ node, messageId: 'intl' })
                else if (inHistory && !mayReadNow && isDate(node.object) && name === 'now')
                    context.report({ node, messageId: 'now' })
            },
            // const { DateTimeFormat } = Intl
            Property(node) {
                if (
                    node.parent.type === 'ObjectPattern' &&
                    !node.computed &&
                    node.key.type === 'Identifier'
                ) {
                    if (LOCAL_DATE_MEMBERS.has(node.key.name))
                        context.report({ node, messageId: 'local', data: { name: node.key.name } })
                    else if (node.key.name === 'DateTimeFormat')
                        context.report({ node, messageId: 'intl' })
                }
            },
            NewExpression(node) {
                if (!isDate(node.callee)) return
                const [only] = node.arguments
                const text =
                    only !== undefined &&
                    (only.type === 'TemplateLiteral' ||
                        (only.type === 'Literal' && typeof only.value === 'string'))
                if (node.arguments.length !== 1 || text)
                    context.report({ node, messageId: 'construct' })
            },
        }
    },
}

// --- History's imports

/** Modules that format a date or time in the engine's zone, or hold a clock of their own. */
const BANNED_MODULES = [
    'src/i18n/when',
    'src/i18n/dateTime',
    'src/editor/shownName',
    'src/editor/labelText',
    'src/editor/switch',
    'src/editor/loadNotices',
]

/** Names that read the engine's zone or clock: banned from these modules in History files. */
const BANNED_NAMES = [
    { module: 'src/history/createHistoryOperation', names: ['getHistoryOperationContext'] },
    { module: 'src/calendar/calendar', names: ['hostZone'] },
]

const withoutExtension = (name) => name.replace(/\.(?:[cm]?[jt]s|vue)$/, '')

const historyImports = {
    meta: {
        type: 'problem',
        schema: [],
        messages: {
            module: '{{ module }} formats in the engine’s zone. History formats through historyFormat, from the History calendar.',
            name: '{{ name }} reads the engine’s zone or clock. History takes its calendar from calendarClock.ts and its text context from historyOperationContext.',
        },
    },
    create(context) {
        const directory = path.posix.dirname(normalized(context.filename))
        /** The path a specifier names, without an extension; undefined for a package. */
        const resolve = (specifier) => {
            if (typeof specifier !== 'string') return undefined
            if (!specifier.startsWith('.') && !specifier.startsWith('/')) return undefined
            const joined = specifier.startsWith('/') ? specifier : `${directory}/${specifier}`
            return withoutExtension(path.posix.normalize(joined))
        }
        const matches = (resolved, module) =>
            resolved !== undefined &&
            (resolved === `/${module}` ||
                resolved.endsWith(`/${module}`) ||
                resolved.includes(`/${module}/`))
        const bannedModule = (resolved) =>
            BANNED_MODULES.find((module) => matches(resolved, module))
        const bannedNames = (resolved) =>
            BANNED_NAMES.find(({ module }) => matches(resolved, module))?.names

        // `names` is undefined when every name comes along: import(), `* as`, `export *`.
        const check = (node, source, names) => {
            const resolved = resolve(source?.value)
            const module = bannedModule(resolved)
            if (module !== undefined) {
                context.report({ node, messageId: 'module', data: { module } })
                return
            }
            const banned = bannedNames(resolved)
            if (!banned) return
            if (names === undefined) {
                context.report({ node, messageId: 'name', data: { name: banned.join(', ') } })
                return
            }
            for (const { node: at, name } of names)
                if (banned.includes(name))
                    context.report({ node: at, messageId: 'name', data: { name } })
        }
        const nameOf = (identifier) =>
            identifier.type === 'Identifier' ? identifier.name : String(identifier.value)

        return {
            ImportDeclaration(node) {
                const names = []
                let all = false
                for (const specifier of node.specifiers) {
                    if (specifier.type === 'ImportSpecifier')
                        names.push({ node: specifier, name: nameOf(specifier.imported) })
                    else if (specifier.type === 'ImportNamespaceSpecifier') all = true
                }
                check(node, node.source, all ? undefined : names)
            },
            ImportExpression(node) {
                check(node, node.source, undefined)
            },
            ExportNamedDeclaration(node) {
                if (!node.source) return
                check(
                    node,
                    node.source,
                    node.specifiers.map((specifier) => ({
                        node: specifier,
                        name: nameOf(specifier.local),
                    })),
                )
            },
            ExportAllDeclaration(node) {
                check(node, node.source, undefined)
            },
        }
    },
}

export default {
    meta: { name: 'eslint-plugin-local' },
    rules: {
        'no-local-time': noLocalTime,
        'history-imports': historyImports,
    },
}
