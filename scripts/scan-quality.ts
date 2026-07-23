import fs from "fs";
import path from "path";

const rootDir = process.cwd();

function scanDir(dir: string, fileList: string[] = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file === "node_modules" || file === ".next" || file === ".git" || file === "dist") continue;
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      scanDir(filePath, fileList);
    } else if (/\.(ts|tsx|js|jsx)$/.test(file)) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const allFiles = scanDir(path.join(rootDir, "src"));

const matches = {
  skip: [] as string[],
  only: [] as string[],
  todo: [] as string[],
  tsIgnore: [] as string[],
  tsExpectError: [] as string[],
  eslintDisable: [] as string[],
  asAny: [] as string[],
};

for (const file of allFiles) {
  const relativePath = path.relative(rootDir, file);
  const content = fs.readFileSync(file, "utf-8");
  const lines = content.split("\n");

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    if (/\.(skip)\b/.test(line)) matches.skip.push(`${relativePath}:${lineNum} -> ${line.trim()}`);
    if (/\.(only)\b/.test(line)) matches.only.push(`${relativePath}:${lineNum} -> ${line.trim()}`);
    if (/test\.todo/.test(line)) matches.todo.push(`${relativePath}:${lineNum} -> ${line.trim()}`);
    if (/@ts-ignore/.test(line)) matches.tsIgnore.push(`${relativePath}:${lineNum} -> ${line.trim()}`);
    if (/@ts-expect-error/.test(line)) matches.tsExpectError.push(`${relativePath}:${lineNum} -> ${line.trim()}`);
    if (/eslint-disable/.test(line)) matches.eslintDisable.push(`${relativePath}:${lineNum} -> ${line.trim()}`);
    if (/as any\b/.test(line)) matches.asAny.push(`${relativePath}:${lineNum} -> ${line.trim()}`);
  });
}

console.log("=== SCAN QUALITY REPORT ===");
console.log(`Test .skip count: ${matches.skip.length}`);
matches.skip.forEach((m) => console.log("  ", m));

console.log(`Test .only count: ${matches.only.length}`);
matches.only.forEach((m) => console.log("  ", m));

console.log(`Test .todo count: ${matches.todo.length}`);
matches.todo.forEach((m) => console.log("  ", m));

console.log(`@ts-ignore count: ${matches.tsIgnore.length}`);
matches.tsIgnore.forEach((m) => console.log("  ", m));

console.log(`@ts-expect-error count: ${matches.tsExpectError.length}`);
matches.tsExpectError.forEach((m) => console.log("  ", m));

console.log(`eslint-disable count: ${matches.eslintDisable.length}`);
matches.eslintDisable.forEach((m) => console.log("  ", m));

console.log(`as any count: ${matches.asAny.length}`);
matches.asAny.forEach((m) => console.log("  ", m));
