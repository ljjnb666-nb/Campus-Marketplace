/**
 * 跨平台 E2E 编排（npm run e2e）：
 * build → e2e-setup → playwright test → e2e-teardown（无论如何都回收资源）
 * Playwright 退出码原样透传，失败不被吞掉。
 */
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: isWindows,
      env,
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const buildCode = await run("npm", ["run", "build"]);
  if (buildCode !== 0) {
    process.exit(buildCode);
  }

  const setupCode = await run("npm", ["run", "e2e:setup"]);
  if (setupCode !== 0) {
    process.exit(setupCode);
  }

  const testCode = await run("npx", ["playwright", "test"]);

  // teardown 尽力而为：即使测试失败也回收 MinIO/Redis 资源
  await run("npm", ["run", "e2e:teardown"]);

  process.exit(testCode);
}

main().catch((error) => {
  console.error("[e2e] 编排失败:", error);
  process.exit(1);
});
