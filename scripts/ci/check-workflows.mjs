import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const workflowDirectory = ".github/workflows";
const workflowFiles = (await readdir(workflowDirectory))
  .filter((file) => /\.ya?ml$/.test(file))
  .sort();
const failures = [];

for (const file of workflowFiles) {
  const filePath = path.join(workflowDirectory, file);
  const contents = await readFile(filePath, "utf8");

  const forbiddenPatterns = [
    [/\bpull_request_target\s*:/, "pull_request_target is forbidden"],
    [/\bself-hosted\b/, "self-hosted runners are forbidden"],
    [/\bwrite-all\b/, "write-all permissions are forbidden"],
    [/\bsecrets\s*:\s*inherit\b/, "inherited secrets are forbidden"],
    [/\bcontents\s*:\s*write\b/, "contents: write requires a reviewed policy exception"],
  ];

  for (const [pattern, message] of forbiddenPatterns) {
    if (pattern.test(contents)) {
      failures.push(`${filePath}: ${message}`);
    }
  }

  for (const [index, line] of contents.split("\n").entries()) {
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);

    if (!match || match[1].startsWith("./")) {
      continue;
    }

    if (!/@[0-9a-f]{40}$/.test(match[1])) {
      failures.push(
        `${filePath}:${index + 1}: action must be pinned to a full commit SHA`,
      );
    }
  }
}

const ciWorkflow = await readFile(path.join(workflowDirectory, "ci.yml"), "utf8");
if (!/^permissions:\n  contents: read$/m.test(ciWorkflow)) {
  failures.push(".github/workflows/ci.yml: top-level token must be contents: read");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Workflow policy passed for ${workflowFiles.length} files.`);
}

