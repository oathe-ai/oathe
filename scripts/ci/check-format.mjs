import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const roots = [".github", "scripts", "src", "tests", "plugin", "bin"];
const extensions = new Set([".js", ".json", ".md", ".mjs", ".yaml", ".yml"]);
const failures = [];

async function visit(relativePath) {
  const entries = await readdir(relativePath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(relativePath, entry.name);

    if (entry.isDirectory()) {
      await visit(entryPath);
      continue;
    }

    if (!extensions.has(path.extname(entry.name))) {
      continue;
    }

    const contents = await readFile(entryPath, "utf8");
    const lines = contents.split("\n");

    if (!contents.endsWith("\n")) {
      failures.push(`${entryPath}: missing final newline`);
    }

    lines.forEach((line, index) => {
      if (/\t/.test(line)) {
        failures.push(`${entryPath}:${index + 1}: tab character`);
      }
      if (/[ \t]+$/.test(line)) {
        failures.push(`${entryPath}:${index + 1}: trailing whitespace`);
      }
    });
  }
}

for (const root of roots) {
  await visit(root);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Formatting policy passed.");
}

