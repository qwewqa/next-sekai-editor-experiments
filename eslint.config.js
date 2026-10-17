import eslint from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tsEslint from 'typescript-eslint'

export default tsEslint.config(
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            'dist-native/**',
            'public/**',
            'test-results*/**',
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

    // Where platform names may appear (Part 0, 0.11.1): native code stays out of shared code.
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
                        "MemberExpression[object.name='platform'][property.name=/^(kind|os)$/]",
                    message: 'Ask platform.capabilities; kind and os are for src/platform.',
                },
            ],
        },
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

    eslintConfigPrettier,
)
