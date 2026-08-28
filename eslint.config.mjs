/**
 * ESLint configuration for the project.
 *
 * See https://typescript-eslint.io for additional linting options.
 * Formatting is handled by Prettier, not ESLint.
 */
// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["out/**", "docs/**", "scripts/esbuild.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: globals.nodeBuiltin,
    },
  },
  {
    rules: {
      curly: "warn",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/naming-convention": [
        "warn",
        {
          selector: "import",
          format: ["camelCase", "PascalCase"],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
        },
      ],
    },
  },
);
