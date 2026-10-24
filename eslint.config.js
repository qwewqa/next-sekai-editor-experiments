import eslint from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tsEslint from 'typescript-eslint'
import local from './scripts/eslint-plugin-local.mjs'

export default tsEslint.config(
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            'dist-native/**',
            '.vite-cache/**',
            'public/**',
            'test-results*/**',
            'perf-results/**',
            'tests/design-capture*/**',
            '.idea/**',
        ],
    },

    {
        files: ['src/**/*.{ts,vue}'],
        extends: [
            eslint.configs.recommended,
            ...tsEslint.configs.strictTypeChecked,
            ...tsEslint.configs.stylisticTypeChecked,
            ...pluginVue.configs['flat/recommended'],
        ],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.browser,
            parserOptions: {
                parser: tsEslint.parser,
                extraFileExtensions: ['vue'],
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            'vue/block-lang': [
                'error',
                {
                    script: {
                        lang: 'ts',
                    },
                },
            ],
            '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
            '@typescript-eslint/switch-exhaustiveness-check': 'error',
            // An all-type inline import still loads its module, adding import cycles.
            '@typescript-eslint/no-import-type-side-effects': 'error',
            '@typescript-eslint/restrict-template-expressions': [
                'error',
                {
                    allowAny: false,
                    allowBoolean: false,
                    allowNever: true,
                    allowNullish: false,
                    allowNumber: true,
                    allowRegExp: false,
                },
            ],
            '@typescript-eslint/no-unnecessary-condition': [
                'error',
                {
                    allowConstantLoopConditions: true,
                },
            ],
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    varsIgnorePattern: '^_',
                },
            ],
        },
    },

    // Where platform names may appear: native code stays out of shared code.
    {
        files: ['src/**/*.{ts,vue}'],
        // The native implementation, the native-only folders and the one loader that imports them.
        ignores: [
            'src/platform/native/**',
            'src/library/**',
            'src/projects/**',
            'src/nativeLoader.ts',
        ],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            regex: '^@tauri-apps/',
                            message: 'Only the native implementation may import @tauri-apps.',
                        },
                        {
                            regex: '(^|/)platform/native(/|$)',
                            message: 'Reach the native platform only through #platform.',
                        },
                        {
                            regex: '(^|/)(library|projects)(/|$)',
                            message: 'The native-only folders load only through the native loader.',
                        },
                    ],
                },
            ],
            'no-restricted-syntax': [
                'error',
                {
                    selector: "Identifier[name='__NATIVE__']",
                    message: '__NATIVE__ belongs to the build configuration and the native loader.',
                },
                {
                    selector: "Identifier[name='isTauri']",
                    message: 'isTauri belongs to the native implementation.',
                },
                {
                    selector:
                        'ImportExpression[source.value=/^@tauri-apps.|(^|.)platform.native(.|$)|(^|.)(library|projects)(.|$)/]',
                    message: 'Native code is imported only by the native code and its loader.',
                },
            ],
        },
    },
    {
        files: ['src/**/*.{ts,vue}'],
        ignores: ['src/platform/**', 'src/library/**', 'src/projects/**', 'src/nativeLoader.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: "Identifier[name='__NATIVE__']",
                    message: '__NATIVE__ belongs to the build configuration and the native loader.',
                },
                {
                    selector: "Identifier[name='isTauri']",
                    message: 'isTauri belongs to the native implementation.',
                },
                {
                    selector:
                        'ImportExpression[source.value=/^@tauri-apps.|(^|.)platform.native(.|$)|(^|.)(library|projects)(.|$)/]',
                    message: 'Native code is imported only by the native code and its loader.',
                },
                {
                    selector:
                        "MemberExpression[object.name='platform'][property.name=/^(kind|os)$/]",
                    message: 'Ask platform.capabilities; kind and os are for src/platform.',
                },
                {
                    selector:
                        "MemberExpression[object.property.name='platform'][property.name=/^(kind|os)$/]",
                    message: 'Ask platform.capabilities; kind and os are for src/platform.',
                },
                {
                    selector:
                        "MemberExpression[object.name='platform'][property.value=/^(kind|os)$/]",
                    message: 'Ask platform.capabilities; kind and os are for src/platform.',
                },
                {
                    selector:
                        "MemberExpression[object.property.name='platform'][property.value=/^(kind|os)$/]",
                    message: 'Ask platform.capabilities; kind and os are for src/platform.',
                },
                {
                    selector:
                        "VariableDeclarator[init.name='platform'] > ObjectPattern > Property[key.name=/^(kind|os)$/]",
                    message: 'Ask platform.capabilities; kind and os are for src/platform.',
                },
                {
                    selector:
                        "VariableDeclarator[init.property.name='platform'] > ObjectPattern > Property[key.name=/^(kind|os)$/]",
                    message: 'Ask platform.capabilities; kind and os are for src/platform.',
                },
            ],
        },
    },

    // History's time: local time is read only by the calendar module, and every
    // date and time on a History surface is written through the History clock and `historyFormat`.
    // These are two rules of the local plugin and add no `no-restricted-imports` object: a second
    // one would replace the native-code bans above.
    {
        files: [
            'src/editor/history/**/*.{ts,vue}',
            'src/history/**/*.ts',
            'src/editor/peek.ts',
            'src/local/worker/timelineHandlers.ts',
            'src/local/days.ts',
        ],
        plugins: { local },
        rules: { 'local/no-local-time': 'error' },
    },
    // A day of use is not a calendar day: only countDayOfUse and NO_USE_DAY (days.ts) and
    // the row types and storedDay (records/rows.ts) make a UseDay.
    {
        files: ['src/**/*.{ts,vue}'],
        ignores: ['src/local/days.ts', 'src/local/records/rows.ts'],
        plugins: { local },
        rules: { 'local/no-use-day-cast': 'error' },
    },
    {
        files: ['src/editor/history/**/*.{ts,vue}', 'src/editor/peek.ts', 'src/history/**/*.ts'],
        ignores: [
            'src/editor/history/historyFormat.ts',
            'src/editor/history/calendarClock.ts',
            'src/history/createHistoryOperation.ts',
            'src/history/operationPresentation/format.ts',
        ],
        plugins: { local },
        rules: { 'local/history-imports': 'error' },
    },

    // The storage worker's covered reads go through the storedRead gate.
    {
        files: ['src/**/*.{ts,vue}'],
        plugins: { local },
        rules: { 'local/stored-reads': 'error' },
    },

    {
        files: ['tests/**/*.ts', '*.config.ts'],
        extends: [eslint.configs.recommended, ...tsEslint.configs.recommended],
        languageOptions: {
            globals: { ...globals.browser, ...globals.node },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-import-type-side-effects': 'error',
        },
    },

    {
        files: ['scripts/**/*.mjs', 'builtin-assets/**/*.mjs', 'tests/**/*.mjs', '*.config.js'],
        extends: [eslint.configs.recommended],
        languageOptions: {
            globals: globals.node,
        },
    },
    // The perf harness's page functions run in the browser.
    {
        files: ['scripts/perf/run.mjs'],
        languageOptions: { globals: { ...globals.browser, ...globals.node } },
    },

    eslintConfigPrettier,
)
