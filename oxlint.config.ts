// Lint policy per the user-level TypeScript stack note (~/.claude/docs/typescript.md § Lint &
// static-analysis policy): size, complexity and type-escape hatches are errors, not review comments.
// Oxlint with tsgolint because this repo is on TypeScript 7, whose npm package has no JavaScript API
// for typescript-eslint or eslint-plugin-sonarjs (docs/plans/EXECPLAN_NUDGE.md decision A17).
// sonarjs's cognitive-complexity and assertions-in-tests have no Oxlint equivalent; `complexity` is
// 15 rather than 20 to compensate for the first, and the rule that every new test is first seen to
// fail covers the second. Exceptions go here with a reason and a removal condition, never inline.
import { defineConfig } from "oxlint";

export default defineConfig({
  "plugins": [
    "typescript",
    "eslint",
    "oxc"
  ],
  "jsPlugins": [
    "eslint-plugin-security"
  ],
  "categories": {
    "correctness": "error"
  },
  "options": {
    "typeAware": true
  },
  "ignorePatterns": [
    "node_modules/**",
    ".wrangler/**"
  ],
  "rules": {
    "max-lines-per-function": [
      "error",
      {
        "max": 60,
        "skipBlankLines": true,
        "skipComments": true
      }
    ],
    "complexity": [
      "error",
      15
    ],
    "max-depth": [
      "error",
      4
    ],
    "max-nested-callbacks": [
      "error",
      4
    ],
    "max-params": [
      "warn",
      6
    ],
    "no-empty": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/consistent-type-assertions": [
      "error",
      {
        "assertionStyle": "never"
      }
    ],
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/await-thenable": "error",
    "typescript/no-base-to-string": "error",
    "typescript/no-redundant-type-constituents": "error",
    "security/detect-eval-with-expression": "error",
    "security/detect-non-literal-regexp": "error",
    "security/detect-unsafe-regex": "error",
    "security/detect-buffer-noassert": "error",
    "security/detect-new-buffer": "error",
    "security/detect-pseudoRandomBytes": "error",
    "security/detect-child-process": "error",
    "security/detect-non-literal-fs-filename": "error",
    "security/detect-non-literal-require": "error",
    "security/detect-disable-mustache-escape": "error",
    "security/detect-no-csrf-before-method-override": "error",
    "security/detect-bidi-characters": "error"
  },
  "overrides": [
    {
      "files": [
        "src/**/*.test.ts",
        "src/testing/**/*.ts"
      ],
      "rules": {
        "max-lines-per-function": [
          "error",
          {
            "max": 120,
            "skipBlankLines": true,
            "skipComments": true
          }
        ]
      }
    }
  ]
});
