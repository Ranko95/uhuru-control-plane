// @ts-check

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig({
    files: ['**/*.{js,ts}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
        curly: ['error', 'all'],
        'one-var': ['error', 'never'],
        'no-nested-ternary': 'error',
        'padding-line-between-statements': [
            'error',
            { blankLine: 'always', prev: '*', next: ['function', 'class', 'multiline-block-like'] },
            { blankLine: 'always', prev: ['function', 'class', 'multiline-block-like'], next: '*' },
            { blankLine: 'always', prev: '*', next: 'return' },
        ],
    },
});
