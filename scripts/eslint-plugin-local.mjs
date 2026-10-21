// The editor's own lint rules (Part 1 §1.6.8.7): History reads local time and formats dates only
// through the calendar module, the History clock and `historyFormat`. The rules work by name, not
// by type, so they are cheap and need no project. Where each rule applies, and its allowlist, is in
// eslint.config.js. `local/stored-reads` keeps the storage worker's covered reads in one gate.

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

const GLOBALS = new Set(['globalThis', 'window', 'self'])

/** `Date`, `globalThis.Date`, `window.Date` or `self.Date`. */
const isDate = (node) =>
    (node.type === 'Identifier' && node.name === 'Date') ||
    (node.type === 'MemberExpression' &&
        node.object.type === 'Identifier' &&
        GLOBALS.has(node.object.name) &&
        memberName(node) === 'Date')

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
            call: 'Date() without new writes the local time as text. Local dates come from src/calendar/calendar.ts.',
            now: 'Date.now() belongs to calendarClock.ts. Read the History calendar; time an interval with performance.now().',
        },
    },
    create(context) {
        const file = normalized(context.filename)
        const inHistory = file.includes('/src/editor/history/')
        const mayReadNow = file.endsWith('/src/editor/history/calendarClock.ts')
        const visitor = {
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
                    // const { now } = Date
                    const from = node.parent.parent
                    if (from.type === 'VariableDeclarator' && from.init && isDate(from.init)) {
                        if (node.key.name === 'parse') context.report({ node, messageId: 'parse' })
                        else if (node.key.name === 'now' && inHistory && !mayReadNow)
                            context.report({ node, messageId: 'now' })
                    }
                    if (LOCAL_DATE_MEMBERS.has(node.key.name))
                        context.report({ node, messageId: 'local', data: { name: node.key.name } })
                    else if (node.key.name === 'DateTimeFormat')
                        context.report({ node, messageId: 'intl' })
                }
            },
            // Date()
            CallExpression(node) {
                if (isDate(node.callee)) context.report({ node, messageId: 'call' })
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
        // A .vue file's template is visited as well (vue-eslint-parser); a script-only parser has
        // no template.
        const services = context.sourceCode.parserServices
        return typeof services?.defineTemplateBodyVisitor === 'function'
            ? services.defineTemplateBodyVisitor(visitor, visitor)
            : visitor
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
            const resolved = resolve(sourceText(source))
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
        // A string, or a template literal with no holes: import(`../i18n/when`).
        const sourceText = (source) =>
            source?.type === 'TemplateLiteral' && source.expressions.length === 0
                ? (source.quasis[0].value.cooked ?? undefined)
                : source?.value
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

// --- Storage reads

/**
 * The storage methods whose empty answer a caller acts on: they are called only through the gate in
 * src/local/storedRead.ts, which returns the value or the failure. Equal to its COVERED_READS
 * (tests/local/storedReadClasses.test.ts).
 */
const COVERED_READS = [
    'readHandle',
    'listHandleOwners',
    'readBindings',
    'readChainRecord',
    'replaceDecision',
    'openEarlierChains',
    'openPendingImports',
    'openImportTarget',
    'listRecovered',
    'readRecovered',
    'listKept',
    'findEdits',
]

/** A method name written out: a string literal, or a template literal without holes. */
const literalName = (node) => {
    if (node === undefined) return undefined
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
        return node.quasis[0].value.cooked ?? undefined
    return undefined
}

const storedReads = {
    meta: {
        type: 'problem',
        schema: [],
        messages: {
            gate: '{{ method }} is a covered storage read. Read it through storedRead() (src/local/storedRead.ts), which returns the value or the failure, and write the failed case.',
        },
    },
    create(context) {
        if (normalized(context.filename).endsWith('src/local/storedRead.ts')) return {}
        const visitor = {
            CallExpression(node) {
                const { callee } = node
                if (callee.type !== 'MemberExpression' || memberName(callee) !== 'call') return
                const method = literalName(node.arguments[0])
                if (method !== undefined && COVERED_READS.includes(method))
                    context.report({ node, messageId: 'gate', data: { method } })
            },
        }
        const services = context.sourceCode.parserServices
        return typeof services?.defineTemplateBodyVisitor === 'function'
            ? services.defineTemplateBodyVisitor(visitor, visitor)
            : visitor
    },
}

export default {
    meta: { name: 'eslint-plugin-local' },
    rules: {
        'no-local-time': noLocalTime,
        'history-imports': historyImports,
        'stored-reads': storedReads,
    },
}
