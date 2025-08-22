import { defineConfig, globalIgnores } from "eslint/config";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default defineConfig([
  globalIgnores([
    // directories
    "**/.coverage_artifacts",
    "**/.coverage_cache",
    "**/.coverage_contracts",
    "**/artifacts",
    "**/build",
    "**/cache",
    "**/coverage",
    "**/dist",
    "**/node_modules",
    "**/types",
    "**/typechain-types",
    "**/scripts",
    "**/.venv",
    "**/fhevmTemp",
    // files
    "**/*.env",
    "**/*.log",
    "**/.DS_Store",
    "**/.pnp.*",
    "**/bun.lockb",
    "**/coverage.json",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    "**/.solcover.js",
    "**/eslint.config.mjs",
  ]),

  // JavaScript files configuration
  {
    files: ["**/*.js", "**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },

  // TypeScript files configuration
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: compat.extends(
      "eslint:recommended",
      "plugin:@typescript-eslint/eslint-recommended",
      "plugin:@typescript-eslint/recommended",
      "prettier",
    ),

    plugins: {
      "@typescript-eslint": typescriptEslint,
    },

    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",

      parserOptions: {
        project: "tsconfig.json",
      },
    },

    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreIIFE: true,
          ignoreVoid: true,
        },
      ],

      "@typescript-eslint/no-inferrable-types": "off",

      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "_",
          varsIgnorePattern: "_",
        },
      ],
    },
  },
]);
