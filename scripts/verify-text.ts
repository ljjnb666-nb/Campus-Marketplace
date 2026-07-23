import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const roots = ["src", "docs", "prisma", "scripts", "README.md", ".env.example"];
const textFilePattern = /\.(ts|tsx|md|prisma|json|example)$/;
const ignoredDirectories = new Set(["node_modules", ".next", ".git", "coverage"]);

const mojibakePatterns = [
  "�",
  "鍟",
  "鏈",
  "鏃",
  "鏍",
  "鐢",
  "璇",
  "鎴",
  "浣",
  "娑",
  "閫",
  "鎻",
  "閭",
  "瀵",
  "纭",
  "璐",
  "绠",
  "锛",
  "銆",
  "鈥",
  "毬",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
];

type Finding = {
  file: string;
  line: number;
  pattern: string;
  text: string;
};

function walk(filePath: string, findings: Finding[]) {
  const stats = statSync(filePath);

  if (stats.isDirectory()) {
    if (ignoredDirectories.has(path.basename(filePath))) {
      return;
    }

    for (const child of readdirSync(filePath)) {
      walk(path.join(filePath, child), findings);
    }

    return;
  }

  if (!textFilePattern.test(filePath)) {
    return;
  }

  if (path.normalize(filePath) === path.normalize("scripts/verify-text.ts")) {
    return;
  }

  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const pattern = mojibakePatterns.find((candidate) => line.includes(candidate));

    if (pattern) {
      findings.push({
        file: filePath,
        line: index + 1,
        pattern,
        text: line.trim(),
      });
    }
  }
}

const findings: Finding[] = [];

for (const root of roots) {
  walk(root, findings);
}

if (findings.length > 0) {
  console.error("Text verification failed. Possible mojibake was found:");
  console.error(JSON.stringify(findings, null, 2));
  process.exit(1);
}

console.log("Text verification passed.");
