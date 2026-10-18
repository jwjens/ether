// S4 — PLACEABLE = WIRED (docs/screen-builder-design-2026-10-18.md §3, §2.1, §2.7). Static: reads the registry's own
// source and the tree, so a module that is not fully wired cannot be registered — enforced here, not remembered.
//
// For every registry entry:
//   · its component is IMPORTED into registry.ts from the app's own file, outside
//     src/modules, and that file really exports it — a module is never defined under src/modules;
//   · its proof test exists, is under src/modules/proof, and renders this module type through ModuleFrame;
//   · its help doc exists, is flat in docs/ as help-module-<type>.md, and follows the docs/help-sweepers.md template;
//   · its empty state has text, and the proof test asserts it on a rendered, empty module.
// The registry imports the app's components, which read window / document when they load.
import "./miniDom";
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { MODULES } from "../registry";
import { ROOT } from "./pageLists";

const rel = (...p: string[]) => path.join(ROOT, ...p);
const read = (p: string) => fs.readFileSync(rel(p), "utf8").replace(/\r/g, "");
const registrySrc = read("src/modules/registry.ts");

/** identifier → module specifier, from registry.ts's import lines. */
const imports = new Map<string, string>();
for (const m of registrySrc.matchAll(/^import\s+(?!type\b)([\s\S]*?)\s+from\s+"([^"]+)";/gm)) {
  const [, clause, spec] = m;
  const def = clause.match(/^([A-Za-z_$][\w$]*)/);
  if (def && !clause.startsWith("{")) imports.set(def[1], spec);
  const named = clause.match(/\{([^}]*)\}/);
  if (named) for (const n of named[1].split(",")) { const id = n.trim().split(/\s+as\s+/).pop(); if (id) imports.set(id, spec); }
}

/** The identifier the entry of `type` assigns to `field` in registry.ts. */
function fieldOf(type: string, field: string): string | null {
  const start = registrySrc.indexOf(`type: "${type}",`);
  if (start < 0) return null;
  const next = registrySrc.indexOf(`type: "`, start + 1);
  const block = registrySrc.slice(start, next < 0 ? undefined : next);
  const m = block.match(new RegExp(`\\b${field}:\\s*([A-Za-z_$][\\w$]*)`));
  return m ? m[1] : null;
}

function resolveSpec(spec: string): string | null {
  const base = path.resolve(rel("src/modules"), spec);
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) if (fs.existsSync(base + ext)) return base + ext;
  return null;
}

function assertImportedFromApp(type: string, field: string) {
  const id = fieldOf(type, field);
  expect(id, `${type}.${field} is not a plain identifier in registry.ts`).toBeTruthy();
  const spec = imports.get(id!);
  expect(spec, `${type}.${field} (${id}) is not imported into registry.ts — is it defined there?`).toBeTruthy();
  const file = resolveSpec(spec!);
  expect(file, `${type}.${field}: cannot resolve "${spec}"`).toBeTruthy();
  const relFile = path.relative(ROOT, file!).replace(/\\/g, "/");
  expect(relFile.startsWith("src/modules/"), `${type}.${field} comes from ${relFile}: a module is the app's own component, never one defined under src/modules`).toBe(false);
  const src = fs.readFileSync(file!, "utf8");
  const exported = new RegExp(`export\\s+(default\\s+)?(function|const|class)\\s+${id}\\b|export\\s*\\{[^}]*\\b${id}\\b`).test(src);
  expect(exported, `${relFile} does not export ${id}`).toBe(true);
  return relFile;
}

describe("S4 — every registered module is fully wired, or it is not placeable", () => {
  it("the registry is not empty and types are unique", () => {
    expect(MODULES.length).toBeGreaterThan(0);
    expect(new Set(MODULES.map(m => m.type)).size).toBe(MODULES.length);
  });

  for (const m of MODULES) {
    describe(m.type, () => {
      it("its component is the app's own, imported from the app's file", () => {
        assertImportedFromApp(m.type, "component");
        expect(typeof m.component).toBe("function");
      });
      it("its proof test exists and renders this module through ModuleFrame", () => {
        expect(m.proof.startsWith("src/modules/proof/") && /\.test\.tsx?$/.test(m.proof), m.proof).toBe(true);
        expect(fs.existsSync(rel(m.proof)), `${m.proof} does not exist`).toBe(true);
        const src = read(m.proof);
        expect(src).toMatch(/from "\.\.\/ModuleFrame"/);
        expect(src).toContain(`type="${m.type}"`);
      });
      it("its help doc exists, flat in docs/, to the help template", () => {
        expect(m.help).toBe(`docs/help-module-${m.type}.md`);
        expect(fs.existsSync(rel(m.help)), `${m.help} does not exist`).toBe(true);
        const doc = read(m.help);
        expect(doc).toMatch(new RegExp(`^---\\nfeature: module-${m.type}\\n`));
        for (const h of ["## What it is", "## When to use it", "## Set it up", "## Not in this version (by design)", "## Related"]) {
          expect(doc, `${m.help} is missing "${h}"`).toContain(h);
        }
      });
      it("its empty state has text, and the proof asserts it on an empty module", () => {
        expect(m.empty.text.trim().length).toBeGreaterThan(0);
        expect(fs.existsSync(rel(m.empty.source)), m.empty.source).toBe(true);
        expect(read(m.proof)).toContain(`moduleEntry("${m.type}").empty.text`);
      });
      it("one station per layout (decision 1), and a known instances policy", () => {
        expect(m.station).toBe("follows-layout");
        expect(["many", "one-per-window", "one"]).toContain(m.instances);
      });
    });
  }

  it("nothing under src/modules defines a React component other than the frame itself", () => {
    const dir = rel("src/modules");
    const files = fs.readdirSync(dir).filter(f => /\.tsx?$/.test(f));
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      const comps = [...src.matchAll(/^(?:export\s+)?function\s+([A-Z]\w*)\s*\(/gm)].map(x => x[1]);
      const allowed = f === "ModuleFrame.tsx" ? ["ModuleSurface", "ModuleFrame", "ModuleBody"] : [];
      expect(comps.filter(c => !allowed.includes(c)), `src/modules/${f} defines a component`).toEqual([]);
    }
  });
});
