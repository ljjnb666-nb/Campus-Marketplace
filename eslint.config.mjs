import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@next/next/no-img-element": "off",
    },
  },
  // 分层架构约束:components/pages 不得在运行时直接访问数据层。
  // 正确的依赖方向:components/pages → actions / repositories → lib/prisma。
  // 组件需要的数据由 app 层(server component)查询后经 props 传入,或走 server actions。
  // 类型导入(import type)会在编译期被擦除,不构成运行时耦合,因此放行。
  {
    files: ["src/components/**/*.{ts,tsx}"],
    ignores: ["src/components/**/*.test.*"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/prisma", "@/lib/prisma/**", "@prisma/client", "@prisma/client/**"],
              allowTypeImports: true,
              message:
                "组件层禁止直接访问数据库:请通过 server actions 获取数据,或通过 props 传入数据(分层规则:components/pages → actions / repositories → prisma)。",
            },
            {
              group: ["@/repositories", "@/repositories/**"],
              allowTypeImports: true,
              message: "组件层禁止直接访问数据层，请通过 props 或 server action 获取数据。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/**/*.{ts,tsx}"],
    ignores: ["src/app/**/*.test.*"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/prisma", "@/lib/prisma/**", "@prisma/client", "@prisma/client/**"],
              allowTypeImports: true,
              message:
                "页面层禁止直接使用 Prisma:请通过 @/repositories 中的仓储函数读写数据(分层规则:components/pages → actions / repositories → prisma)。",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // vitest coverage HTML 输出目录:
    "coverage/**",
  ]),
]);

export default eslintConfig;
