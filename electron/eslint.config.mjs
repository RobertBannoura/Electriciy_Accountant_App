import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['node_modules'] },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: js.configs.recommended.rules,
  },
]
