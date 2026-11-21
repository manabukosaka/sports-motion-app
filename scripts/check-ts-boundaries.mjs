import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const script = fileURLToPath(import.meta.url);
const ignoredDirectories = new Set(["node_modules", "dist", ".next", ".expo"]);

function workspaceList(root) {
  return ["packages", "apps"].flatMap((group) => {
    const directory = join(root, group);
    if (!existsSync(directory)) {
      return [];
    }
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !ignoredDirectories.has(entry.name))
      .sort((first, second) => first.name.localeCompare(second.name, "en"))
      .map(({ name }) => {
        const folder = join(directory, name);
        const manifest = join(folder, "package.json");
        return {
          folder,
          group,
          manifest: existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : {},
        };
      });
  });
}

function* sourceFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  entries.sort((first, second) => first.name.localeCompare(second.name, "en"));
  for (const entry of entries) {
    const { name } = entry;
    const path = join(directory, name);
    if (entry.isDirectory() && !ignoredDirectories.has(name)) {
      yield* sourceFiles(path);
    } else if (entry.isFile() && /\.(?:ts|tsx|mts|mjs)$/u.test(name)) {
      yield path;
    }
  }
}

function moduleReferences(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const references = [];

  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifier = node.moduleReference.expression;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      [specifier] = node.arguments;
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const { line } = source.getLineAndCharacterOfPosition(specifier.getStart(source));
      references.push({ specifier: specifier.text, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return references;
}

function hasTarget(target) {
  if (typeof target === "string") {
    return target.startsWith("./");
  }
  return target !== null && typeof target === "object" && Object.values(target).some(hasTarget);
}

function isExported(exports, subpath) {
  if (exports === undefined) {
    return subpath === ".";
  }
  if (!exports || typeof exports === "string" || Array.isArray(exports)) {
    return subpath === "." && hasTarget(exports);
  }
  if (Object.hasOwn(exports, subpath)) {
    return hasTarget(exports[subpath]);
  }
  const keys = Object.keys(exports);
  if (subpath === "." && keys.every((key) => !key.startsWith("."))) {
    return hasTarget(exports);
  }
  const patterns = keys
    .filter((key) => key.startsWith("./") && key.includes("*"))
    .map((key) => ({
      key,
      prefix: key.slice(0, key.indexOf("*")),
      suffix: key.slice(key.indexOf("*") + 1),
    }))
    .sort(
      (first, second) =>
        second.prefix.length - first.prefix.length || second.key.length - first.key.length,
    );
  const match = patterns.find(
    ({ prefix, suffix }) =>
      subpath.length > prefix.length + suffix.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix),
  );
  return match !== undefined && hasTarget(exports[match.key]);
}

function within(folder, path) {
  const difference = relative(folder, path);
  return difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

function packageName(specifier) {
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
}

function relativeTarget(specifier, from) {
  if (specifier.startsWith("file://")) {
    return fileURLToPath(specifier);
  }
  if (isAbsolute(specifier) || /^\.{1,2}(?:[\\/]|$)/u.test(specifier)) {
    return resolve(from, specifier.replaceAll("\\", "/"));
  }
}

function findCycles(graph, report) {
  const visited = new Set();
  const active = new Set();
  const path = [];

  function visit(workspace) {
    if (active.has(workspace)) {
      report([...path.slice(path.indexOf(workspace)), workspace]);
      return;
    }
    if (visited.has(workspace)) {
      return;
    }
    visited.add(workspace);
    active.add(workspace);
    path.push(workspace);
    for (const dependency of graph.get(workspace)) {
      visit(dependency);
    }
    path.pop();
    active.delete(workspace);
  }
  for (const workspace of graph.keys()) {
    visit(workspace);
  }
}

function check(root) {
  const workspaces = workspaceList(root);
  const byName = new Map(
    workspaces
      .filter(({ manifest }) => manifest.name)
      .map((workspace) => [workspace.manifest.name, workspace]),
  );
  const graph = new Map(workspaces.map((workspace) => [workspace, new Set()]));
  const violations = [];
  const label = (workspace) => workspace.manifest.name ?? relative(root, workspace.folder);
  const containingWorkspace = (path) => workspaces.find(({ folder }) => within(folder, path));

  function addEdge(from, to, location) {
    if (!to || to === from) {
      return;
    }
    graph.get(from).add(to);
    if (from.group === "packages" && to.group === "apps") {
      violations.push(`${location}: packages cannot depend on apps (${label(to)})`);
    }
  }

  for (const workspace of workspaces) {
    const { folder, manifest } = workspace;
    const dependencyNames = new Map();
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, specifier] of Object.entries(manifest[field] ?? {}).sort()) {
        const target = /^(?:npm|workspace|file|link):(.*)$/u.exec(specifier)?.[1] ?? "";
        const path = relativeTarget(target, folder);
        const alias = target.replace(/(.+)@.*$/u, "$1");
        const dependency = path
          ? containingWorkspace(path)
          : (byName.get(alias) ?? byName.get(name));
        if (dependency) {
          dependencyNames.set(name, dependency);
        }
        addEdge(
          workspace,
          dependency,
          `${relative(root, join(folder, "package.json"))} (${field}.${name})`,
        );
      }
    }
    for (const file of sourceFiles(folder)) {
      for (const { specifier, line } of moduleReferences(file)) {
        const location = `${relative(root, file)}:${line}`;
        const path = relativeTarget(specifier, dirname(file));
        const name = packageName(specifier);
        const target = path
          ? containingWorkspace(path)
          : (dependencyNames.get(name) ?? byName.get(name));
        addEdge(workspace, target, location);
        if (!target || target === workspace) {
          continue;
        }
        const subpath = `.${specifier.slice(name.length)}`;
        if (path || !isExported(target.manifest.exports, subpath)) {
          violations.push(
            `${location}: cross-workspace import must use a public export (${specifier})`,
          );
        }
      }
    }
  }

  findCycles(graph, (path) => violations.push(`workspace cycle: ${path.map(label).join(" -> ")}`));
  if (violations.length > 0) {
    process.stderr.write(`${violations.join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`PASS TypeScript workspace boundaries (${workspaces.length} workspaces)\n`);
  return 0;
}

function selfTest() {
  const fixtures = mkdtempSync(join(tmpdir(), "sports-motion-ts-boundaries-"));
  const first = "packages/first";
  const second = "packages/second";
  const app = "apps/client";
  const member = (folder) => `@sports-motion/${folder.split("/").at(-1)}`;
  const cases = [
    [
      "bare import of a package with a main entry point",
      "",
      {
        [second]: { exports: undefined, main: "./index.mjs" },
      },
      {
        [`${first}/index.ts`]: 'import "@sports-motion/second";',
        [`${second}/index.mjs`]: "export const value = true;",
      },
    ],
    [
      "public exports, local imports and app dependency",
      "",
      {},
      {
        [`${first}/index.ts`]: 'export { value } from "@sports-motion/second/public";',
        [`${second}/index.ts`]:
          'const ignored = "import \'@sports-motion/first/src/private\'"; // export * from "@sports-motion/client";',
        [`${app}/index.ts`]: 'import "@sports-motion/first"; import "./local.js";',
      },
    ],
    [
      "deep static import",
      "must use a public export",
      {},
      {
        [`${first}/index.ts`]: 'import "@sports-motion/second/src/private";',
      },
    ],
    [
      "deep re-export",
      "must use a public export",
      {},
      {
        [`${first}/index.ts`]: 'export * from "@sports-motion/second/dist/private";',
      },
    ],
    [
      "deep import through workspace alias",
      "must use a public export",
      {
        [first]: { dependencies: { alias: `workspace:${member(second)}@*` } },
      },
      {
        [`${first}/index.ts`]: 'import "alias/src/private";',
      },
    ],
    [
      "deep type-only import",
      "must use a public export",
      {},
      {
        [`${first}/index.ts`]: 'import type { Private } from "@sports-motion/second/src/private";',
      },
    ],
    [
      "deep import type expression",
      "must use a public export",
      {},
      {
        [`${first}/index.mts`]:
          'type Private = import("@sports-motion/second/src/private").Private;',
      },
    ],
    [
      "relative cross-workspace import",
      "must use a public export",
      {},
      {
        [`${first}/index.tsx`]: 'export { value } from "../second/index.js";',
      },
    ],
    [
      "literal dynamic import",
      "must use a public export",
      {},
      {
        [`${first}/index.mjs`]: "import(`@sports-motion/second/src/private`);",
      },
    ],
    [
      "declared dependency cycle",
      "workspace cycle",
      {
        [first]: { dependencies: { [member(second)]: "workspace:*" } },
        [second]: { dependencies: { [member(first)]: "workspace:*" } },
      },
      {},
    ],
    [
      "source dependency cycle",
      "workspace cycle",
      {},
      {
        [`${first}/index.ts`]: 'export type { Value } from "@sports-motion/second";',
        [`${second}/index.ts`]: 'import "@sports-motion/first";',
      },
    ],
    [
      "mixed dependency cycle",
      "workspace cycle",
      { [first]: { dependencies: { [member(second)]: "workspace:*" } } },
      { [`${second}/index.ts`]: 'import "@sports-motion/first";' },
    ],
    [
      "package importing app",
      "packages cannot depend on apps",
      {},
      {
        [`${first}/index.ts`]: 'import "@sports-motion/client";',
      },
    ],
    [
      "package declaring app",
      "packages cannot depend on apps",
      {
        [first]: { dependencies: { [member(app)]: "workspace:*" } },
      },
      {},
    ],
  ];

  try {
    for (const [index, [name, violation, manifests, sources]] of cases.entries()) {
      const root = join(fixtures, String(index));
      for (const folder of [first, second, app]) {
        mkdirSync(join(root, folder), { recursive: true });
        writeFileSync(
          join(root, folder, "package.json"),
          JSON.stringify({
            name: member(folder),
            exports: { ".": "./index.ts", "./public": "./public.ts" },
            ...manifests[folder],
          }),
        );
      }
      for (const [file, source] of Object.entries(sources)) {
        writeFileSync(join(root, file), source);
      }
      const run = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
      assert.ifError(run.error);
      assert.equal(run.status, violation ? 1 : 0, `${name}: ${run.stderr || run.stdout}`);
      if (violation) {
        assert.equal(run.stderr.trim().split("\n").length, 1, run.stderr);
        assert.ok(run.stderr.includes(violation), `${name}: ${run.stderr}`);
      } else {
        assert.equal(run.stderr, "");
        assert.ok(run.stdout.includes("PASS TypeScript workspace boundaries"));
      }
      process.stdout.write(`PASS ${name} (exit ${run.status})\n`);
    }
  } finally {
    rmSync(fixtures, { recursive: true });
  }
}

const [argument, fixtureRoot] = process.argv.slice(2);
if (argument === "--self-test") {
  selfTest();
} else {
  process.exitCode = check(
    argument === "--root" ? resolve(fixtureRoot) : resolve(dirname(script), ".."),
  );
}
