import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PROMPTS_DIR = path.join(ROOT, "prompts", "builtins");
const OUTPUT_FILE = path.join(ROOT, "static", "prompts.index.json");

const REQUIRED_FIELDS = [
  "id",
  "title",
  "category",
  "description",
  "tags",
  "author",
  "source",
  "updatedAt",
];

function toPosix(p) {
  return p.replace(/\\/g, "/");
}

async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(abs)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(abs);
    }
  }
  return out;
}

function parseFrontmatter(raw, file) {
  const trimmed = raw.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---\n")) {
    throw new Error(`Missing frontmatter start in ${file}`);
  }
  const end = trimmed.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error(`Missing frontmatter end in ${file}`);
  }

  const fm = trimmed.slice(4, end).split("\n");
  const body = trimmed.slice(end + 5).trim();
  const meta = {};

  for (const line of fm) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim();

    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const value = rawValue
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
      meta[key] = value;
      continue;
    }

    if (/^\d+$/.test(rawValue)) {
      meta[key] = Number(rawValue);
      continue;
    }

    meta[key] = rawValue.replace(/^"|"$/g, "");
  }

  for (const field of REQUIRED_FIELDS) {
    if (meta[field] === undefined || meta[field] === null || meta[field] === "") {
      throw new Error(`Missing required field "${field}" in ${file}`);
    }
  }

  if (!Array.isArray(meta.tags)) {
    throw new Error(`"tags" must be array in ${file}`);
  }

  return {
    ...meta,
    template: body,
  };
}

async function main() {
  const files = await walk(PROMPTS_DIR);
  const prompts = [];
  const ids = new Set();

  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const parsed = parseFrontmatter(raw, file);

    if (ids.has(parsed.id)) {
      throw new Error(`Duplicate prompt id "${parsed.id}" in ${file}`);
    }
    ids.add(parsed.id);
    prompts.push(parsed);
  }

  prompts.sort((a, b) => a.title.localeCompare(b.title));
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(prompts, null, 2), "utf8");
  console.log(
    `[prompts] Built ${prompts.length} prompts -> ${toPosix(path.relative(ROOT, OUTPUT_FILE))}`,
  );
}

main().catch((err) => {
  console.error("[prompts] Build failed:", err.message);
  process.exit(1);
});

