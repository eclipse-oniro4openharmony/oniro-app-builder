#!/usr/bin/env node
'use strict';

// Adapted for oniro-app from deveco-cli 1.3.10 (commit 99e3725fc2c5,
// packages/cli/src/resources/arkts-check.cjs), Copyright (c) 2026 Huawei Device
// Co., Ltd., MIT licence (see LICENSE beside this file). Changes from upstream:
// the SDK is given with `--sdk <dir>` (an OpenHarmony SDK API directory, the
// layout DevEco keeps under sdk/default/openharmony) instead of being found by
// looking for a DevEco Studio install, and the HarmonyOS `hms/ets` API path is
// given with `--hms <dir>` instead of being assumed beside it. `--fix` also
// adds `export` for "File '...' is not a module" (an imported file that exports
// nothing yet), which upstream leaves alone. Everything else is upstream's.

const path = require('path');
const fs = require('fs');

// --- Argument parsing ---

function parseArgs(argv) {
  // 默认只读检查；--fix 才改写源文件，避免直跑脚本时静默修改代码。
  const args = { project: '', files: [], fix: false, serve: false, sdk: '', hms: '' };
  let i = 2;
  while (i < argv.length) {
    if (argv[i] === '--project' && argv[i + 1]) {
      args.project = path.resolve(argv[++i]);
    } else if (argv[i] === '--sdk' && argv[i + 1]) {
      args.sdk = path.resolve(argv[++i]);
    } else if (argv[i] === '--hms' && argv[i + 1]) {
      args.hms = path.resolve(argv[++i]);
    } else if (argv[i] === '--serve') {
      args.serve = true;
    } else if (argv[i] === '--no-fix') {
      args.fix = false;
    } else if (argv[i] === '--fix') {
      args.fix = true;
    } else if (argv[i] === '--files') {
      i++;
      while (i < argv.length && !argv[i].startsWith('--')) {
        args.files.push(argv[i++]);
      }
      continue;
    } else if (!argv[i].startsWith('--')) {
      args.files.push(argv[i]);
    }
    i++;
  }
  return args;
}

// --- SDK location ---
//
// `sdkDir` is the directory holding ets/, previewer/ and toolchains/: an
// OpenHarmony SDK API directory (<sdk-root>/20) or DevEco's
// sdk/default/openharmony. `hmsEtsDir` is HarmonyOS's sdk/default/hms/ets, added
// to the checker's external API paths when the project targets HarmonyOS.
// Without --sdk, DEVECO_HOME is honoured the way upstream reads it.
function resolveSdk(args) {
  if (args.sdk) return { sdkDir: args.sdk, hmsEtsDir: args.hms || '' };
  const envHome = (process.env.DEVECO_HOME || '').trim();
  if (envHome && fs.existsSync(envHome)) {
    const hms = path.join(envHome, 'sdk', 'default', 'hms', 'ets');
    return {
      sdkDir: path.join(envHome, 'sdk', 'default', 'openharmony'),
      hmsEtsDir: args.hms || (fs.existsSync(hms) ? hms : ''),
    };
  }
  return { sdkDir: '', hmsEtsDir: '' };
}

function findEtsLoader(sdkDir) {
  const candidates = [
    path.join(sdkDir, 'ets', 'build-tools', 'ets-loader'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'lib', 'ets_checker.js'))) return c;
  }
  return null;
}

// --- Collect .ets files from project ---

function collectEtsFiles(projectPath) {
  const results = [];
  const srcDir = path.join(projectPath, 'entry', 'src', 'main', 'ets');
  if (!fs.existsSync(srcDir)) return results;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'oh_modules' || entry.name === 'build') continue;
        walk(full);
      } else if (entry.name.endsWith('.ets') && !entry.name.endsWith('.d.ets')) {
        results.push(full);
      }
    }
  }
  walk(srcDir);
  return results;
}

// Every .ets under any module's src/main/ets, not just `entry` (collectEtsFiles
// above is entry-only because it feeds the checker's default file list). Used by
// cross-file checks that need to see declarations the caller did not pass in.
// Cached per project path: a single run re-checks the same project up to twice
// (once more after auto-fix), and auto-fix never adds or removes source files.
const projectEtsFileCache = new Map();

function collectProjectEtsFiles(projectPath) {
  const cached = projectEtsFileCache.get(projectPath);
  if (cached) return cached;

  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'oh_modules' || entry.name === 'build') continue;
        if (entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.name.endsWith('.ets') && !entry.name.endsWith('.d.ets')) {
        results.push(full);
      }
    }
  }

  // 模块可嵌套于分组目录（如 commons/lib_foundation、components/address_management），
  // 故递归查找任意深度的 src/main/ets，而不是只枚举一层 {mod}/src/main/ets。
  function findModuleEtsDirs(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === 'oh_modules' || entry.name === 'build') continue;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'src') {
        const etsDir = path.join(full, 'main', 'ets');
        if (fs.existsSync(etsDir)) {
          walk(etsDir);
          continue;
        }
      }
      findModuleEtsDirs(full, depth + 1);
    }
  }
  findModuleEtsDirs(projectPath, 0);

  projectEtsFileCache.set(projectPath, results);
  return results;
}

// `files` plus every other project .ets, de-duplicated by absolute path. Keeps
// the caller's exact paths (which may be absolute or already-resolved) first so
// per-file caches keyed on them still hit.
function unionProjectFiles(files, projectPath) {
  const seen = new Set(files.map((f) => path.resolve(f)));
  const merged = [...files];
  for (const f of collectProjectEtsFiles(projectPath)) {
    const abs = path.resolve(f);
    if (seen.has(abs)) continue;
    seen.add(abs);
    merged.push(f);
  }
  return merged;
}

// --- Per-file diagnostic cache (warm --serve process only) ---
//
// A file's checker diagnostics depend on its own content plus the content it
// imports, so caching on the file's own hash alone would go stale the moment a
// dependency changed. Each entry is therefore keyed on a *closure* hash: this
// file's content plus every relatively-imported file reachable from it.
//
// Two things sit outside any closure and would silently go stale, so they are
// folded into a process-wide epoch that clears the whole cache when it changes:
// installed dependencies (`ohpm install` mid-session) and ambient `.d.ets`
// declarations, which affect files with no import edge to them.
const fileDiagCache = new Map(); // abs -> { closureHash, diagnostics }
let cacheEpoch = '';

function hashText(text) {
  return require('crypto').createHash('sha1').update(text).digest('hex');
}

function fileHash(abs) {
  try {
    return hashText(fs.readFileSync(abs, 'utf-8'));
  } catch {
    return 'missing';
  }
}

function computeEpoch(projectPath, sdkDir) {
  const parts = [sdkDir];
  for (const rel of ['oh-package.json5', 'oh-package-lock.json5', 'build-profile.json5']) {
    parts.push(rel, fileHash(path.join(projectPath, rel)));
  }
  for (const abs of collectAmbientDeclarations(projectPath)) {
    parts.push(path.relative(projectPath, abs), fileHash(abs));
  }
  return hashText(parts.join('\n'));
}

// Ambient `.d.ets` files declare types with no import edge, so any file's
// diagnostics can depend on them. Collected project-wide, excluding deps.
function collectAmbientDeclarations(projectPath) {
  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'oh_modules' || entry.name === 'build') continue;
        if (entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.d.ets') || entry.name.endsWith('.d.ts')) results.push(full);
    }
  }
  walk(projectPath);
  return results;
}

// Resolve a relative specifier for closure walking. Wider than
// `resolveModuleFile` (which is .ets-only, for the import fixer): a relative
// `.ts` or `.d.ets` dependency changing must also invalidate the importer.
function resolveClosureDependency(importerAbs, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importerAbs), spec);
  const candidates = /\.(ets|ts)$/.test(base)
    ? [base]
    : [base + '.ets', base + '.ts', base + '.d.ets', base + '.d.ts',
       path.join(base, 'index.ets'), path.join(base, 'index.ts')];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* not present */ }
  }
  return null;
}

const IMPORT_SPEC_RE = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*['"]([^'"]+)['"]/g;

// Hash of `abs` plus every relatively-imported file transitively reachable from
// it. Cycles terminate via `seen`; unresolvable and bare specifiers are ignored
// (bare package imports are covered by the epoch instead).
function closureHash(abs) {
  const seen = new Set();
  const parts = [];
  const stack = [abs];
  while (stack.length > 0) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    let content;
    try { content = fs.readFileSync(current, 'utf-8'); } catch { parts.push(current + ':missing'); continue; }
    parts.push(current + ':' + hashText(content));
    IMPORT_SPEC_RE.lastIndex = 0;
    for (;;) {
      const m = IMPORT_SPEC_RE.exec(content);
      if (!m) break;
      const dep = resolveClosureDependency(current, m[1]);
      if (dep && !seen.has(dep)) stack.push(dep);
    }
  }
  return hashText(parts.sort().join('\n'));
}

// --- Diagnostic output capture ---

function parseDiagnosticLine(line) {
  const errorMatch = line.match(/ArkTS:(ERROR|WARN)\s+File:\s+(.+?):(\d+):(\d+)/);
  if (errorMatch) {
    return { severity: errorMatch[1].toLowerCase(), file: errorMatch[2], line: parseInt(errorMatch[3]), column: parseInt(errorMatch[4]) };
  }
  return null;
}

function parseMessageLine(line) {
  const trimmed = line.trim();
  const ruleMatch = trimmed.match(/^(.+?)\s*\(([a-z][\w-]+)\)\s*$/);
  if (ruleMatch) {
    return { message: ruleMatch[1].trim(), rule: ruleMatch[2] };
  }
  return { message: trimmed, rule: '' };
}

// --- Project-level validation (A-class checks) ---

function loadSystemResourceNames(sdkDir) {
  const candidates = [
    path.join(sdkDir, 'previewer', 'common', 'resources', 'entry', 'resources.txt'),
  ];
  let resFile = '';
  for (const c of candidates) {
    if (fs.existsSync(c)) { resFile = c; break; }
  }
  if (!resFile) return null;

  const names = new Set();
  const content = fs.readFileSync(resFile, 'utf-8');
  const linePattern = /^id:\d+,\s*'[^']*'\s+'([^']+)'/;
  for (const line of content.split('\n')) {
    const m = line.match(linePattern);
    if (m) names.add(m[1]);
  }
  return names;
}

function validateSystemResources(files, sdkDir, projectPath) {
  const validNames = loadSystemResourceNames(sdkDir);
  if (!validNames) return [];

  const diagnostics = [];
  const refPattern = /\$r\(\s*['"]sys\.(media|symbol)\.([^'"]+)['"]\s*\)/g;

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileLines = content.split('\n');
    for (let i = 0; i < fileLines.length; i++) {
      let match;
      refPattern.lastIndex = 0;
      while ((match = refPattern.exec(fileLines[i])) !== null) {
        const resName = match[2];
        if (!validNames.has(resName)) {
          diagnostics.push({
            file: path.relative(projectPath, filePath),
            line: i + 1,
            column: match.index + 1,
            severity: 'error',
            message: `Unknown resource name '${resName}'. No matching sys.${match[1]} resource found in SDK.`,
            rule: 'resource-name-check',
          });
        }
      }
    }
  }
  return diagnostics;
}

// --- app.* resource references ($r('app.media.foo'), $r('app.string.bar')) ---
//
// validateSystemResources above covers only `sys.*` (SDK-provided) names. The
// project's OWN resources are just as easy to get wrong and hvigor rejects them
// with the same 10903329 "Unknown resource name" error: 39 of 93 build errors in
// one bootstrap round were a missing app.media.* image. Resolution is a pure
// existence question — a media file on disk, or a named entry in an element JSON
// — so this needs no type information and cannot disagree with the compiler the
// way a heuristic would.
//
// Qualifier directories (base, dark, zh_CN, ...) are merged into one namespace:
// a name defined under ANY qualifier satisfies a reference, matching how the
// resource compiler resolves at runtime. Only `media` and element JSON kinds are
// indexed; `$r('app.color.x')` etc. resolve through element/color.json, whose
// top-level key ("color") is singularized from the JSON's array key ("colors"
// is not used — element files key on the singular already, e.g. {"color": [...]}).
const APP_RESOURCE_REF_RE = /\$r\(\s*['"]app\.([a-z]+)\.([A-Za-z0-9_]+)['"]\s*\)/g;

// Raw-file resource kinds referenced with $rawfile()/other syntax, not $r('app.*'),
// so an unknown-name check does not apply to them here.
const APP_RESOURCE_INDEXED_KINDS = new Set(['media', 'color', 'string', 'float', 'integer', 'boolean', 'intarray', 'strarray', 'pattern', 'plural', 'profile', 'symbol']);

function loadAppResourceNames(projectPath) {
  const names = new Set();
  let moduleDirs;
  try {
    moduleDirs = fs.readdirSync(projectPath, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return names;
  }

  for (const mod of moduleDirs) {
    if (mod.name === 'node_modules' || mod.name === 'oh_modules' || mod.name.startsWith('.')) continue;
    const resourcesDir = path.join(projectPath, mod.name, 'src', 'main', 'resources');
    let qualifiers;
    try {
      qualifiers = fs.readdirSync(resourcesDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }

    for (const qualifier of qualifiers) {
      const qualifierDir = path.join(resourcesDir, qualifier.name);

      // media/profile: the file's basename (minus extension) is the resource name.
      for (const kind of ['media', 'profile']) {
        const kindDir = path.join(qualifierDir, kind);
        let files;
        try { files = fs.readdirSync(kindDir); } catch { continue; }
        for (const file of files) {
          names.add(`${kind}.${file.replace(/\.[^.]+$/, '')}`);
        }
      }

      // element/*.json: {"color": [{"name": "primary", ...}], ...}
      const elementDir = path.join(qualifierDir, 'element');
      let elementFiles;
      try { elementFiles = fs.readdirSync(elementDir); } catch { continue; }
      for (const file of elementFiles) {
        if (!file.endsWith('.json')) continue;
        let parsed;
        try {
          parsed = JSON.parse(fs.readFileSync(path.join(elementDir, file), 'utf-8'));
        } catch {
          // A malformed element file is its own build error; skipping it here
          // only means we cannot vouch for names it would have defined, and the
          // unknown-name diagnostics below are suppressed for that kind.
          continue;
        }
        for (const [kind, entries] of Object.entries(parsed)) {
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            if (entry && typeof entry.name === 'string') names.add(`${kind}.${entry.name}`);
          }
        }
      }
    }
  }
  return names;
}

function validateAppResources(files, projectPath) {
  const validNames = loadAppResourceNames(projectPath);
  // No resources directory at all (or unreadable): stay silent rather than
  // reporting every reference as unknown.
  if (validNames.size === 0) return [];

  // Only vouch for kinds we actually managed to index; if a project defines no
  // colors at all, a color reference is far more likely to mean our index missed
  // the file than that the reference is wrong.
  const indexedKinds = new Set();
  for (const name of validNames) indexedKinds.add(name.slice(0, name.indexOf('.')));

  const diagnostics = [];
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const relFile = path.relative(projectPath, filePath);
    const fileLines = content.split('\n');
    for (let i = 0; i < fileLines.length; i++) {
      let match;
      APP_RESOURCE_REF_RE.lastIndex = 0;
      while ((match = APP_RESOURCE_REF_RE.exec(fileLines[i])) !== null) {
        const kind = match[1];
        const resName = match[2];
        if (!APP_RESOURCE_INDEXED_KINDS.has(kind)) continue;
        if (!indexedKinds.has(kind)) continue;
        if (validNames.has(`${kind}.${resName}`)) continue;
        diagnostics.push({
          file: relFile,
          line: i + 1,
          column: match.index + 1,
          severity: 'error',
          message: `Unknown resource name '${resName}'. No matching app.${kind} resource is defined under any module's resources/*/${kind === 'media' || kind === 'profile' ? kind : 'element'} directory.`,
          rule: 'app-resource-name-check',
        });
      }
    }
  }
  return diagnostics;
}

function validateRouterPages(projectPath) {
  const candidates = [
    path.join(projectPath, 'entry', 'src', 'main', 'resources', 'base', 'profile', 'main_pages.json'),
    path.join(projectPath, 'src', 'main', 'resources', 'base', 'profile', 'main_pages.json'),
  ];
  let mainPagesPath = '';
  for (const c of candidates) {
    if (fs.existsSync(c)) { mainPagesPath = c; break; }
  }
  if (!mainPagesPath) return [];

  let config;
  try {
    config = JSON.parse(fs.readFileSync(mainPagesPath, 'utf-8'));
  } catch { return []; }

  const pages = config.src || [];
  const diagnostics = [];
  const etsBase = path.join(projectPath, 'entry', 'src', 'main', 'ets');

  for (let i = 0; i < pages.length; i++) {
    const pagePath = pages[i];
    const etsFile = path.join(etsBase, pagePath + '.ets');
    if (!fs.existsSync(etsFile)) {
      diagnostics.push({
        file: path.relative(projectPath, mainPagesPath),
        line: i + 2,
        column: 1,
        severity: 'error',
        message: `Page '${pagePath}.ets' does not exist. Registered in main_pages.json but file not found at entry/src/main/ets/${pagePath}.ets`,
        rule: 'page-file-exists',
      });
      continue;
    }
    const entryDiag = validatePageEntryCount(etsFile, projectPath, pagePath);
    if (entryDiag) diagnostics.push(entryDiag);
  }
  return diagnostics;
}

// --- NavDestination route map (route_map.json / router_map.json) schema ---
//
// A module's dynamic-route profile (referenced from module.json5 as
// `$profile:route_map`, conventionally named route_map.json — some generated
// projects instead write router_map.json, which hvigor also accepts) is
// validated by hvigor against a strict JSON schema at the `ProcessRouterMap`
// build step: `routerMap[]` entries allow only `name`/`pageSourceFile`/
// `buildFunction`/`data`/`customData`, and `name`/`pageSourceFile`/
// `buildFunction` are required (10005/11003/additionalProperties errors,
// observed as build-time-only ajv validation failures). The standalone
// checker never reads this file, so a malformed entry (wrong key name, e.g.
// `pageSource`/`builderFunction` instead of `pageSourceFile`/`buildFunction`,
// or a missing required key) passes arkts_check clean and only surfaces once
// hvigor runs. This is a pure JSON/schema check — no ArkTS parsing involved.
const ROUTE_MAP_ALLOWED_KEYS = new Set(['name', 'pageSourceFile', 'buildFunction', 'data', 'customData']);
const ROUTE_MAP_REQUIRED_KEYS = ['name', 'pageSourceFile', 'buildFunction'];

function validateRouteMapProfile(projectPath) {
  const candidates = [
    path.join(projectPath, 'entry', 'src', 'main', 'resources', 'base', 'profile', 'route_map.json'),
    path.join(projectPath, 'entry', 'src', 'main', 'resources', 'base', 'profile', 'router_map.json'),
    path.join(projectPath, 'src', 'main', 'resources', 'base', 'profile', 'route_map.json'),
    path.join(projectPath, 'src', 'main', 'resources', 'base', 'profile', 'router_map.json'),
  ];
  let routeMapPath = '';
  for (const c of candidates) {
    if (fs.existsSync(c)) { routeMapPath = c; break; }
  }
  if (!routeMapPath) return [];

  const relFile = path.relative(projectPath, routeMapPath);
  let text;
  try { text = fs.readFileSync(routeMapPath, 'utf-8'); } catch { return []; }

  let config;
  try { config = JSON.parse(text); } catch (e) {
    return [{
      file: relFile,
      line: 1,
      column: 1,
      severity: 'error',
      rule: 'route-map-invalid-json',
      message: `Failed to parse ${path.basename(routeMapPath)} as JSON: ${e.message}`,
    }];
  }

  const entries = Array.isArray(config.routerMap) ? config.routerMap : null;
  if (!entries) return [];

  // Locate each `routerMap[i]` object's opening line by counting `{` occurrences
  // in document order — cheap and accurate enough for diagnostics on a
  // hand-authored profile file (no nested objects appear inside an entry).
  const lines = text.split('\n');
  const entryLineIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\{/.test(lines[i])) entryLineIdx.push(i);
  }

  const diagnostics = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const line = (entryLineIdx[i] !== undefined ? entryLineIdx[i] : 0) + 1;
    if (!entry || typeof entry !== 'object') continue;

    for (const key of Object.keys(entry)) {
      if (!ROUTE_MAP_ALLOWED_KEYS.has(key)) {
        diagnostics.push({
          file: relFile,
          line,
          column: 1,
          severity: 'error',
          rule: 'route-map-unknown-key',
          message: `routerMap[${i}] has unknown property '${key}'. Allowed properties are: ${[...ROUTE_MAP_ALLOWED_KEYS].join(', ')}.`,
        });
      }
    }
    for (const req of ROUTE_MAP_REQUIRED_KEYS) {
      if (!(req in entry)) {
        diagnostics.push({
          file: relFile,
          line,
          column: 1,
          severity: 'error',
          rule: 'route-map-missing-key',
          message: `routerMap[${i}] is missing required property '${req}'.`,
        });
      }
    }

    diagnostics.push(...validateRouteMapBuildFunction(entry, i, line, relFile, routeMapPath, projectPath));
  }
  return diagnostics;
}

// 10904336: `buildFunction` must name an exported @Builder in the entry's
// `pageSourceFile`. Declaring the route is the easy half and the compiler only
// objects at packaging time, so the gap is wide -- one project shipped two routes
// whose builders were never written and lost a whole build cycle to it.
//
// hvigor collapses three distinct causes into one "does not exist": absent,
// present but not exported, present but missing the decorator. Each wants a
// different edit, so they are separated here.
//
// Silent when the page file itself is missing: `validateRouterPages` already
// reports that as `page-file-exists`, and a second diagnostic for the same root
// cause would just be noise.
function validateRouteMapBuildFunction(entry, index, line, relFile, routeMapPath, projectPath) {
  const fn = entry.buildFunction;
  const pageSource = entry.pageSourceFile;
  if (typeof fn !== 'string' || !fn || typeof pageSource !== 'string' || !pageSource) {
    return [];
  }

  // `pageSourceFile` is MODULE-relative (`src/main/ets/pages/X.ets`), not
  // project-relative: observed in both a hand-authored profile and hvigor's own
  // generated copy. The profile sits at <module>/src/main/resources/base/profile,
  // so the module root is five levels up from that directory. Deriving it from
  // the profile's own path keeps this correct for a nested `entry/` module and
  // for a project whose single module IS the root.
  const moduleRoot = path.resolve(path.dirname(routeMapPath), '..', '..', '..', '..', '..');
  const pageAbs = path.resolve(moduleRoot, pageSource);
  let pageText;
  try { pageText = fs.readFileSync(pageAbs, 'utf-8'); } catch { return []; }

  const escaped = escapeRegExp(fn);
  // `@Builder` inline before the name, or on any preceding line -- the decorator
  // chain may carry `export` between them.
  const declared = new RegExp(`\\bfunction\\s+${escaped}\\b|@Builder[\\s\\S]{0,120}?\\b${escaped}\\s*\\(`).test(pageText);
  const exported = new RegExp(`\\bexport\\b[\\s\\S]{0,80}?\\b${escaped}\\b`).test(pageText);
  const decorated = new RegExp(`@Builder[\\s\\S]{0,120}?\\b${escaped}\\s*\\(`).test(pageText);

  if (declared && exported && decorated) {
    return [];
  }

  const remedy = !declared
    ? `Define it in '${pageSource}' as an exported '@Builder' function.`
    : !decorated
      ? `'${fn}' exists in '${pageSource}' but carries no '@Builder' decorator. Add '@Builder' above it.`
      : `'${fn}' exists in '${pageSource}' but is not exported. Add 'export' to its declaration.`;

  return [{
    file: relFile,
    line,
    column: 1,
    severity: 'error',
    rule: 'route-map-build-function-missing',
    message: `The buildFunction '${fn}' configured in the routerMap json file does not exist. ${remedy}`,
  }];
}

// 11211104: inside a qualifier directory (`base`, `dark`, `en_US`, ...) the
// resource compiler accepts only these three subdirectories. Anything else fails
// the build at CompileResource, before a single line of ArkTS is compiled.
const QUALIFIER_RESOURCE_DIRS = new Set(['element', 'media', 'profile']);

// Directories that live at the `resources/` top level, as siblings of the
// qualifier directories, NOT inside them. `resources/rawfile` is right;
// `resources/base/rawfile` is the mistake this rule catches -- one project put it
// there and lost its first build to `Invalid resource directory name 'rawfile'`,
// which no static check reported because nothing looked at directory layout.
const TOP_LEVEL_RESOURCE_DIRS = new Set(['rawfile', 'resfile']);

function validateResourceDirNames(projectPath) {
  const diagnostics = [];
  const roots = [
    path.join(projectPath, 'entry', 'src', 'main', 'resources'),
    path.join(projectPath, 'src', 'main', 'resources'),
  ];

  for (const root of roots) {
    let qualifiers;
    try { qualifiers = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }

    for (const qualifier of qualifiers) {
      if (!qualifier.isDirectory()) continue;
      // A top-level entry is either a qualifier directory or rawfile/resfile;
      // both are legal here, and only the former has constrained children.
      if (TOP_LEVEL_RESOURCE_DIRS.has(qualifier.name)) continue;

      const qualifierPath = path.join(root, qualifier.name);
      let children;
      try { children = fs.readdirSync(qualifierPath, { withFileTypes: true }); } catch { continue; }

      for (const child of children) {
        if (!child.isDirectory()) continue;
        if (QUALIFIER_RESOURCE_DIRS.has(child.name)) continue;

        const relDir = path.relative(projectPath, path.join(qualifierPath, child.name));
        const misplaced = TOP_LEVEL_RESOURCE_DIRS.has(child.name);
        const remedy = misplaced
          ? `'${child.name}' belongs at the resources root, as a sibling of '${qualifier.name}'. Move it to '${path.relative(projectPath, path.join(root, child.name))}'.`
          : `Valid values: ${[...QUALIFIER_RESOURCE_DIRS].map((d) => `"${d}"`).join(', ')}. Move its contents into one of those, or delete it.`;

        diagnostics.push({
          // Reported against the directory itself: there is no file to point at,
          // and this is the path the build's own message names.
          file: relDir,
          line: 1,
          column: 1,
          severity: 'error',
          rule: 'resource-dir-name',
          message: `Invalid resource directory name '${child.name}'. ${remedy}`,
        });
      }
    }
  }
  return diagnostics;
}

// A page registered in main_pages.json (or build-profile.json5) must contain
// exactly one top-level `@Entry`-decorated struct in its .ets file; hvigor
// fails the whole build (10905402) if it finds zero or more than one. The
// standalone linter never cross-references main_pages.json against decorator
// counts, so this is a real gap between "arkts_check says 0 errors" and a
// build that still fails. Counts only top-level (unindented) `@Entry` lines —
// nested/commented occurrences inside strings or block comments are out of
// scope for this lightweight heuristic.
function validatePageEntryCount(etsFile, projectPath, pagePath) {
  let content;
  try { content = fs.readFileSync(etsFile, 'utf-8'); } catch { return null; }
  const entryLines = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*@Entry\b/.test(lines[i])) entryLines.push(i + 1);
  }
  const relFile = path.relative(projectPath, etsFile);
  if (entryLines.length === 0) {
    return {
      file: relFile,
      line: 1,
      column: 1,
      severity: 'error',
      message: `Page '${pagePath}.ets' is registered in main_pages.json but has no '@Entry' decorator. A page file must have exactly one '@Entry' decorator.`,
      rule: 'page-entry-count',
    };
  }
  if (entryLines.length > 1) {
    return {
      file: relFile,
      line: entryLines[1],
      column: 1,
      severity: 'error',
      message: `Page '${pagePath}.ets' has ${entryLines.length} '@Entry' decorators (lines ${entryLines.join(', ')}). A page file must have exactly one '@Entry' decorator.`,
      rule: 'page-entry-count',
    };
  }
  return null;
}

// --- @Component vs @ComponentV2 member-decorator consistency ---
//
// ArkUI's V1 state decorators (@State/@Prop/@Link/@Provide/@Consume/@ObjectLink/
// @StorageLink/@StorageProp/@LocalStorageLink/@LocalStorageProp/@BuilderParam)
// only work inside a struct decorated with `@Component`; the V2 decorators
// (@Local/@Param/@Once/@Event/@Provider/@Consumer) only work inside a struct
// decorated with `@ComponentV2`. Both are syntactically valid decorators on
// their own, so the standalone linter's per-token parsing accepts either set
// on any struct — it validates decorator SYNTAX, not which component model the
// enclosing struct belongs to. hvigor's ArkTS linter rejects the mismatch at
// build time (10905338/10905339). This check is single-file only: it just
// needs the struct's own decorator plus its members' decorators, no cross-file
// type resolution (unlike the separate "@State property type is @ObservedV2"
// check, which is out of scope here).
// Mirrors hvigor's COMPONENT_MEMBER_DECORATOR_V1 (ets-loader/lib/constant_define.js),
// which is what validateStructDecorator tests for 10905339. '@BuilderParam' is
// deliberately NOT here even though it is a V1 decorator: @ComponentV2 structs
// support it too (ets-loader/lib/process_struct_componentV2.js has its own
// processBuilderParamProperty and a dedicated 10905107 diagnostic for it), so
// listing it made the legal `@ComponentV2 struct { @BuilderParam content: () => void }`
// a hard error. '@Watch' is likewise excluded -- hvigor allows it in both versions.
const V1_ONLY_MEMBER_DECORATORS = new Set([
  'State', 'Prop', 'Link', 'Provide', 'Consume', 'ObjectLink',
  'StorageLink', 'StorageProp', 'LocalStorageLink', 'LocalStorageProp',
]);
const V2_ONLY_MEMBER_DECORATORS = new Set([
  'Local', 'Param', 'Once', 'Event', 'Provider', 'Consumer',
]);

// `[@Decorators] [export [default]] struct Name {` — captures indent (1),
// inline decorator text (2), and the struct name (3). Shared by every check
// that needs to locate struct declarations and their decorators.
const STRUCT_DECL_RE = /^(\s*)((?:@\w+(?:\([^)]*\))?\s*)*)(?:export\s+(?:default\s+)?)?struct\s+(\w+)\b/;

// Collect `{lineIdx, name, inline}` for every struct declared in `lines`, in
// document order. Struct bodies are delimited by the next struct declaration
// (or EOF), matching the line-range convention the decorator checks already use.
function collectStructs(lines) {
  const structs = [];
  for (let i = 0; i < lines.length; i++) {
    const m = STRUCT_DECL_RE.exec(lines[i]);
    if (m) structs.push({ lineIdx: i, name: m[3], inline: m[2] });
  }
  return structs;
}

// Decorator names attached to the `struct Name {` declaration at `lines[structLineIdx]`:
// any decorators inline on that same line (`inlineDecoratorText`, e.g. `@Entry
// @ComponentV2 struct Foo {`) plus decorator-only lines walking backward
// (mirrors the decorator-chain walk in buildExportEdit).
function collectStructDecorators(lines, structLineIdx, inlineDecoratorText) {
  const names = new Set();
  const inlineRe = /@(\w+)/g;
  let m;
  while ((m = inlineRe.exec(inlineDecoratorText)) !== null) names.add(m[1]);
  let i = structLineIdx - 1;
  while (i >= 0 && /^\s*@\w+(?:\([^)]*\))?\s*$/.test(lines[i])) {
    const dm = /@(\w+)/.exec(lines[i]);
    if (dm) names.add(dm[1]);
    i--;
  }
  return names;
}

// Single-file check: for every `@Component`/`@ComponentV2` struct, scan the
// lines between it and the next struct declaration (or EOF) for member-level
// decorators that belong to the OTHER component model. Line-range scanning
// (not brace matching) is a deliberate simplification — nested inner
// class/struct member decorators inside a component struct's body are rare in
// ArkTS page/component files and this stays a lightweight heuristic, not a
// full parser.
function validateComponentDecoratorConsistency(filePath, projectPath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  const lines = content.split('\n');
  // `export struct Foo {` is the overwhelmingly common form in generated ArkTS
  // (roughly 2/3 of struct declarations across observed bootstrap output) — an
  // earlier version of this regex only matched a bare `struct Foo {`, silently
  // skipping every exported struct and defeating this check for most files.
  const structs = collectStructs(lines);
  if (structs.length === 0) return [];

  const diagnostics = [];
  const relFile = path.relative(projectPath, filePath);

  for (let s = 0; s < structs.length; s++) {
    const { lineIdx, name, inline } = structs[s];
    const decorators = collectStructDecorators(lines, lineIdx, inline);
    const isV2 = decorators.has('ComponentV2');
    const isV1 = decorators.has('Component');
    if (!isV1 && !isV2) continue; // not an ArkUI component struct (e.g. plain data struct)

    const bodyStart = lineIdx + 1;
    const bodyEnd = s + 1 < structs.length ? structs[s + 1].lineIdx : lines.length;
    const forbidden = isV2 ? V1_ONLY_MEMBER_DECORATORS : V2_ONLY_MEMBER_DECORATORS;
    const allowedIn = isV2 ? '@Component' : '@ComponentV2';
    const actualVersion = isV2 ? '@ComponentV2' : '@Component';

    for (let i = bodyStart; i < bodyEnd; i++) {
      const dm = /^\s*@(\w+)\b/.exec(lines[i]);
      if (!dm || !forbidden.has(dm[1])) continue;
      diagnostics.push({
        file: relFile,
        line: i + 1,
        column: 1,
        severity: 'error',
        rule: 'component-decorator-version-mismatch',
        message: `The '@${dm[1]}' decorator can only be used in a 'struct' decorated with '${allowedIn}', but struct '${name}' is decorated with '${actualVersion}'.`,
      });
    }
  }
  return diagnostics;
}

function validateComponentDecorators(files, projectPath) {
  const diagnostics = [];
  for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;
    diagnostics.push(...validateComponentDecoratorConsistency(filePath, projectPath));
  }
  return diagnostics;
}

// --- @State/@Prop/@Provide/@Consume property type vs @ObservedV2 class ---
//
// V1 state decorators (@State/@Prop/@Provide/@Consume) bind their property
// through a Proxy that assumes the property's own class is either a plain
// value or V1-@Observed; a type decorated with @ObservedV2 (a V2-only "this
// class tracks its own @Trace fields" decorator) breaks that assumption and
// hvigor's ArkTS linter rejects it at build time (10905348). Unlike
// `component-decorator-version-mismatch` above (single-file: a member
// decorator vs. its OWN struct's decorator), this needs real cross-file
// resolution — the property's decorator lives in the component file, but the
// referenced type's @ObservedV2 decorator often lives in a different model
// file entirely. Implemented as two passes over the whole project file set:
//   1) index every top-level class decorated with @ObservedV2, by name
//   2) flag every @State/@Prop/@Provide/@Consume property whose simple type
//      annotation matches a name in that index
// Deliberately name-keyed (no module/import resolution): two same-named
// classes in different files where only one is @ObservedV2 would be a false
// negative, but that pattern does not occur in generated ArkTS and a real
// symbol table is out of scope for this lightweight heuristic.
const V1_TYPE_SENSITIVE_DECORATORS = new Set(['State', 'Prop', 'Provide', 'Consume']);

const CLASS_DECL_RE = /^(\s*)((?:@\w+(?:\([^)]*\))?\s*)*)(?:export\s+(?:default\s+)?)?class\s+(\w+)\b/;

// Only a simple (bare identifier) type annotation is matched — `T[]`,
// `Array<T>`, `T | U`, `Map<K, V>` etc. are left alone. Every real build
// failure observed for this rule was a bare class reference (`@State vm:
// ViewModel = ...`); collection/union-typed state is a different, much rarer
// shape and guessing at it risks false positives for no observed payoff.
const STATE_PROPERTY_TYPE_RE = /^\s*@(State|Prop|Provide|Consume)\b(?:\([^)]*\))?\s+\w+\s*:\s*([A-Za-z_$][\w$]*)\b(?!\s*[<[.])/;

// SDK classes that hvigor treats as @ObservedV2 but that never appear as a
// declaration in project source, so collectObservedV2ClassNames' file scan can
// never see them. EMPTY ON PURPOSE, and adding a name is almost certainly wrong:
// hvigor's 10905348 check (ets-loader/lib/validate_ui_syntax.js,
// validatePropertyInStruct -> validatePropertyType -> parsePropertyType) reads
// the resolved type's own `symbol.valueDeclaration` decorators through the TS
// checker, and no class in the ArkUI component declarations carries @ObservedV2
// -- `ets/component/*.d.ts` mentions it only as the
// `declare const ObservedV2: ClassDecorator` definition. The SDK classes that do
// carry it live in `@ohos.arkui.advanced.{ArcSlider,DialogV2,SubHeaderV2,
// ProgressButtonV2,SegmentButtonV2,ToolBarV2}.d.ets` and are never used as
// @State/@Prop property types. 'NavPathStack' was seeded here from a
// misattributed bootstrap failure -- `declare class NavPathStack` in
// `ets/component/navigation.d.ts` carries no decorators at all -- and it made the
// legal `@Prop pathStack: NavPathStack = new NavPathStack()` a hard error.
const SDK_OBSERVED_V2_CLASSES = new Set();

// The @ObservedV2 class index must be built from the WHOLE project, not just
// the checked `files`: the decorated class lives in a model file while the
// offending @State property lives in a page/component file, and the agent
// typically batches a check over one of those groups but not both (observed in
// bootstrap task-009: a 23-file check covering every model and zero pages, so
// the cross-file pair never co-occurred and 5 real 10905348 errors reached
// hvigor). Scanning every project .ets costs ~20 ms (recursive walk + read of
// ~80 KB), which is noise next to runChecker's multi-second tsc pass, and can
// only ever ADD declarations to the index — the reported diagnostics are still
// keyed to properties found in `files`, so widening this cannot introduce a
// false positive on a file the caller did not ask about.
function collectObservedV2ClassNames(files, projectPath) {
  const names = new Set(SDK_OBSERVED_V2_CLASSES);
  const declarationFiles = projectPath ? unionProjectFiles(files, projectPath) : files;
  for (const filePath of declarationFiles) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = CLASS_DECL_RE.exec(lines[i]);
      if (!m) continue;
      const decorators = collectStructDecorators(lines, i, m[2]);
      if (decorators.has('ObservedV2')) names.add(m[3]);
    }
  }
  return names;
}

function validateObservedV2PropertyTypes(files, projectPath) {
  const observedV2Classes = collectObservedV2ClassNames(files, projectPath);
  if (observedV2Classes.size === 0) return [];

  const diagnostics = [];
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    const relFile = path.relative(projectPath, filePath);
    for (let i = 0; i < lines.length; i++) {
      const m = STATE_PROPERTY_TYPE_RE.exec(lines[i]);
      if (!m) continue;
      const decoratorName = m[1];
      const typeName = m[2];
      if (!observedV2Classes.has(typeName)) continue;
      diagnostics.push({
        file: relFile,
        line: i + 1,
        column: 1,
        severity: 'error',
        rule: 'observed-v2-state-property-type',
        message: `The type of the '@${decoratorName}' property can not be a class decorated with '@ObservedV2'. '${typeName}' is decorated with '@ObservedV2'; use a plain class here, or move this member to a '@ComponentV2' struct using '@Local'/'@Param' instead of '@${decoratorName}'.`,
      });
    }
  }
  return diagnostics;
}

// --- ArkUI component-model rules (10905xxx) not covered by the ArkTS linter ---
//
// Everything below validates the ArkUI COMPONENT MODEL, which only hvigor's
// CompileArkTS task checks. etsStandaloneChecker (what runChecker runs) validates
// ArkTS syntax and types, so these violations pass the static check cleanly and
// only surface as a failed build — 25 of 25 compiler errors across one 16-case
// bootstrap round were of this kind, and raising arkts_check frequency cannot
// help because the checker never looks at these rules.

// In a '@ComponentV2' struct, a member with NO decorator is a "regular" property
// and ArkUI forbids the call site from initializing it (10905324). The common
// instance is a callback (`onBack`, `onCardClick`) declared bare and then passed
// as `Child({ onBack: () => {...} })`; the fix is to decorate it '@Param'.
//
// V1 '@Component' structs are DELIBERATELY EXCLUDED: there, passing an
// undecorated member from the parent is the ordinary way to hand a component its
// callbacks, and it compiles cleanly (verified against bootstrap projects that
// build successfully with exactly this shape, e.g. `onPause: () => void = () =>
// {}` in a '@Component' struct initialized by its caller). Flagging those was a
// false positive on 13 call sites across 3 passing projects.
//
// Detection needs the component's declaration (which members are undecorated)
// and its call sites, which usually live in different files — so the member index
// is built over the whole project, while diagnostics are only reported for the
// caller files the tool was asked to check.
const REGULAR_PROPERTY_DECL_RE = /^\s*(?:private\s+|protected\s+|public\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*(?:\?|!)?\s*:\s*[^=;]+(?:=|$|;)/;

// Members that are methods/builders, not data properties: never "regular
// properties" in the 10905324 sense.
const NON_PROPERTY_MEMBER_RE = /^\s*(?:private\s+|protected\s+|public\s+|static\s+|async\s+)*(?:build|aboutToAppear|aboutToDisappear|onPageShow|onPageHide|onBackPress|onDidBuild|pageTransition)\s*\(/;

// A '@Local' member is the V2 struct's OWN state: ArkUI forbids the parent from
// specifying it at the call site too (same "cannot be initialized here" family as
// 10905324, reported by hvigor as 10905208/10905209). It is indexed alongside the
// undecorated members because both are answered by the same call-site walk; only
// the wording of the fix differs ('@Local' -> '@Param', undecorated -> add '@Param').
const LOCAL_MEMBER_DECL_RE = /^\s*@Local\b(?:\([^)]*\))?\s+(?:private\s+|protected\s+|public\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*(?:\?|!)?\s*[:=]/;

// Net '{' minus '}' on a line, ignoring braces inside string literals, template
// literals, block comments and after a line comment. Used to tell a struct's
// DIRECT members (brace depth 1) from everything nested inside a method or
// build() body.
//
// `state` carries quote/comment context ACROSS lines and MUST be threaded through
// a whole file scan. Without it every line restarts as "not in a string", so a
// multi-line template literal leaks its contents into the brace count: a stray
// '}' inside the literal's text pushes depth below the struct body and the
// following lines get mistaken for member declarations. That is exactly how
// bootstrap task-012 produced an unfixable 'regular-property-init' — a nested
// call-site argument (`viewModel: this.viewModel`) was indexed as an undecorated
// member of the very struct that declared it '@Param', so no edit to the
// declaration could clear the diagnostic and the component had to be deleted.
function countBraceDelta(line, state) {
  const st = state || { quote: null, inBlockComment: false };
  let delta = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (st.inBlockComment) {
      if (ch === '*' && line[i + 1] === '/') { st.inBlockComment = false; i++; }
      continue;
    }
    if (st.quote) {
      if (ch === '\\') { i++; continue; }
      // Only a template literal spans lines; an unterminated '/" is a lexical
      // error, so resetting at EOL keeps one bad line from corrupting the rest.
      if (ch === st.quote) st.quote = null;
      continue;
    }
    if (ch === '/' && line[i + 1] === '*') { st.inBlockComment = true; i++; continue; }
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '"' || ch === "'" || ch === '`') { st.quote = ch; continue; }
    if (ch === '{') delta++;
    else if (ch === '}') delta--;
  }
  if (st.quote === '"' || st.quote === "'") st.quote = null;
  return delta;
}

// End line (exclusive) of the struct body opening at `lines[lineIdx]`, found by
// brace matching rather than by "wherever the next struct declaration starts".
// The line-range approximation over-runs in two ways that both cause false
// positives: the LAST struct in a file swallows every trailing helper/export, and
// any struct whose successor's declaration line is not matched absorbs that
// successor's whole body -- including its call sites.
function findStructBodyEnd(lines, lineIdx, state) {
  let depth = countBraceDelta(lines[lineIdx], state);
  if (depth <= 0) return lineIdx + 1;
  for (let i = lineIdx + 1; i < lines.length; i++) {
    depth += countBraceDelta(lines[i], state);
    if (depth <= 0) return i + 1;
  }
  return lines.length;
}

// componentName -> Map(member name -> 'regular' | 'local'), one entry per struct
// DECLARATION rather than per name. Two different files may each declare a
// '@ComponentV2 struct Card'; merging them by bare name lets one file's
// undecorated member flag the other file's correctly-'@Param'-decorated one. The
// call-site walk resolves a name to candidate declarations and only reports a key
// that every candidate agrees is undecorated, so an ambiguous name cannot produce
// a false positive.
function collectComponentRegularProperties(files) {
  const index = new Map();
  const add = (name, members) => {
    if (members.size === 0) return;
    const list = index.get(name);
    if (list) list.push(members);
    else index.set(name, [members]);
  };
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    const structs = collectStructs(lines);
    for (let s = 0; s < structs.length; s++) {
      const { lineIdx, name, inline } = structs[s];
      const decorators = collectStructDecorators(lines, lineIdx, inline);
      // V2 only — see the note above on why '@Component' is excluded.
      if (!decorators.has('ComponentV2')) continue;

      // Brace-matched, and clamped to the next struct declaration so that a
      // miscounted body cannot run past a sibling and absorb its call sites.
      const nextDecl = s + 1 < structs.length ? structs[s + 1].lineIdx : lines.length;
      const matched = findStructBodyEnd(lines, lineIdx, { quote: null, inBlockComment: false });
      const bodyEnd = Math.min(matched, nextDecl);
      const members = new Map();
      // Brace depth relative to the struct body: 1 == a direct member of the
      // struct, >1 == inside a method/build()/@Builder body or a nested literal.
      // Only depth 1 is scanned. Without this, a call site the component itself
      // writes inside build() -- `Child({ themeColor: this.themeColor, })` --
      // matches REGULAR_PROPERTY_DECL_RE and gets indexed as an undecorated
      // member of the ENCLOSING struct, so every caller passing that same
      // property name is then flagged. That was 8 false positives on one
      // bootstrap project whose theme color threads down four component levels,
      // all of them on properties correctly declared '@Param'.
      const state = { quote: null, inBlockComment: false };
      let depth = countBraceDelta(lines[lineIdx], state);
      for (let i = lineIdx + 1; i < bodyEnd; i++) {
        const line = lines[i];
        // Whether THIS line sits at member level is decided before its own braces
        // are applied: a method declaration is a member-level line, but what
        // follows it is not.
        const atMemberLevel = depth === 1;
        const insideText = state.quote !== null || state.inBlockComment;
        depth += countBraceDelta(line, state);
        // A line that STARTS inside a template literal or block comment is prose,
        // never a declaration.
        if (!atMemberLevel || insideText) continue;

        // Skip a decorated member (and anything that is not a property decl).
        if (/^\s*@\w+/.test(line)) {
          const local = LOCAL_MEMBER_DECL_RE.exec(line);
          if (local) members.set(local[1], 'local');
          // Decorators on their own lines decorate the NEXT non-decorator line;
          // consume the whole chain. `@Param` and `@Require` are routinely stacked
          // one per line, and consuming only a single line left the real member
          // declaration to fall through to REGULAR_PROPERTY_DECL_RE below — which
          // indexed a correctly-decorated '@Param' as undecorated.
          if (/^\s*@\w+(?:\([^)]*\))?\s*$/.test(line)) {
            let j = i;
            let sawLocal = /^\s*@Local\s*$/.test(line);
            while (j + 1 < bodyEnd && /^\s*@\w+(?:\([^)]*\))?\s*$/.test(lines[j + 1])) {
              j++;
              if (/^\s*@Local\s*$/.test(lines[j])) sawLocal = true;
              depth += countBraceDelta(lines[j], state);
            }
            if (j + 1 < bodyEnd) {
              j++;
              const next = /^\s*(?:private\s+|protected\s+|public\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*(?:\?|!)?\s*[:=]/.exec(lines[j]);
              // The decorated member is accounted for either way: recorded as
              // '@Local', or simply consumed so it is not read as undecorated.
              if (next && sawLocal) members.set(next[1], 'local');
              // The consumed line's braces still count (`@Builder\nfoo() {`).
              depth += countBraceDelta(lines[j], state);
            }
            i = j;
          }
          continue;
        }
        if (NON_PROPERTY_MEMBER_RE.test(line)) continue;
        // A method declaration: `name(args) {` / `name(): T {`
        if (/^\s*(?:private\s+|protected\s+|public\s+|static\s+|async\s+)*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::[^{]+)?\{/.test(line)) continue;
        const m = REGULAR_PROPERTY_DECL_RE.exec(line);
        if (m) members.set(m[1], 'regular');
      }
      add(name, members);
    }
  }
  return index;
}

// Independent confirmation that `member` really is undecorated in every
// declaration of `componentName`: scan each declaring struct's text for a state
// decorator attached to that member, inline (`@Param x: T`) or on the lines above
// it. Deliberately NOT brace-depth aware — it answers "does a decorator for this
// name appear anywhere in this struct's text", which is the safe direction to err
// in: a stray match suppresses a diagnostic, it can never invent one.
const STATE_MEMBER_DECORATORS = /@(Param|Local|Once|Require|Event|Provider|Consumer|State|Prop|Link|ObjectLink|Provide|Consume|StorageLink|StorageProp|LocalStorageLink|LocalStorageProp|BuilderParam|Builder)\b/;

function declaresDecoratedMember(declarationFiles, componentName, member) {
  const memberRe = new RegExp(`^\\s*(?:@\\w+(?:\\([^)]*\\))?\\s+)*(?:private\\s+|protected\\s+|public\\s+|readonly\\s+)*${member}\\s*(?:\\?|!)?\\s*[:=]`);
  for (const filePath of declarationFiles) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    if (!content.includes(componentName) || !content.includes(member)) continue;
    const lines = content.split('\n');
    const structs = collectStructs(lines);
    for (let s = 0; s < structs.length; s++) {
      if (structs[s].name !== componentName) continue;
      const nextDecl = s + 1 < structs.length ? structs[s + 1].lineIdx : lines.length;
      const bodyEnd = Math.min(
        findStructBodyEnd(lines, structs[s].lineIdx, { quote: null, inBlockComment: false }),
        nextDecl,
      );
      for (let i = structs[s].lineIdx + 1; i < bodyEnd; i++) {
        if (!memberRe.test(lines[i])) continue;
        // Inline decorators on the declaration line itself.
        if (STATE_MEMBER_DECORATORS.test(lines[i])) return true;
        // Or a chain of decorator-only lines directly above it.
        for (let j = i - 1; j >= 0 && /^\s*@\w+(?:\([^)]*\))?\s*$/.test(lines[j]); j--) {
          if (STATE_MEMBER_DECORATORS.test(lines[j])) return true;
        }
      }
    }
  }
  return false;
}

function validateRegularPropertyInit(files, projectPath) {
  const declarationFiles = projectPath ? unionProjectFiles(files, projectPath) : files;
  const index = collectComponentRegularProperties(declarationFiles);
  if (index.size === 0) return [];

  const diagnostics = [];
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    const relFile = path.relative(projectPath, filePath);

    for (let i = 0; i < lines.length; i++) {
      // Call site: `ComponentName({` — the multi-line object-literal form. The
      // single-line form `Child({ a: 1 })` is matched by the same regex.
      const call = /(?:^|[^\w.$])([A-Z][\w$]*)\s*\(\s*\{/.exec(lines[i]);
      if (!call) continue;
      const componentName = call[1];
      const candidates = index.get(componentName);
      if (!candidates) continue;
      // A name may resolve to several declarations across the project. Report only
      // what EVERY candidate agrees on, and prefer the stricter 'local' wording
      // only when it is unanimous too.
      const members = new Map();
      for (const [key, kind] of candidates[0]) {
        if (candidates.every((c) => c.get(key) === kind)) members.set(key, kind);
      }
      if (members.size === 0) continue;

      // Walk the argument object until its braces balance, flagging keys that
      // name a regular property. Keys are matched against the literal's own text
      // span (not anchored to line start) so both the multi-line form and the
      // single-line `Child({ cb: () => {} })` form are covered.
      let depth = 0;
      let started = false;
      for (let j = i; j < lines.length; j++) {
        // On the call's own line, skip past `Component(` so the component name is
        // not mistaken for a key; later lines are scanned whole.
        const offset = j === i ? call.index + call[0].length : 0;
        const text = lines[j].slice(offset);

        // The call regex already consumed the literal's opening `{`, so on the
        // call's own line we start INSIDE the object at depth 1.
        if (j === i) { depth = 1; started = true; }

        // Only keys at the literal's TOP level (depth 1) are its own properties;
        // a nested object's keys belong to that object.
        const keyRe = /(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*:/g;
        const topLevelKeys = new Set();
        let km;
        while ((km = keyRe.exec(text)) !== null) {
          // Count braces up to the KEY IDENTIFIER, not to the match start: the
          // regex consumes its own '{' delimiter, so measuring to km.index leaves
          // that brace uncounted and a nested literal's keys read as depth 1.
          // `Child({ cfg: { tag: 'x' } })` then flagged 'tag' as Child's own
          // property.
          const idOffset = km.index + km[0].indexOf(km[1]);
          let d = depth;
          for (let k = 0; k < idOffset; k++) {
            if (text[k] === '{') d++;
            else if (text[k] === '}') d--;
          }
          if (d === 1) topLevelKeys.add(km[1]);
        }

        let local = depth;
        for (const ch of text) {
          if (ch === '{') { local++; started = true; }
          else if (ch === '}') local--;
        }
        depth = local;

        for (const key of topLevelKeys) {
          const kind = members.get(key);
          if (!kind) continue;
          // Last-resort guard: the index is heuristic, so confirm against the raw
          // declaration text before accusing a property of being undecorated. If
          // ANY declaration of this component carries a state decorator on this
          // member, the index entry is wrong and reporting it would produce a
          // diagnostic the model cannot fix by writing correct code.
          if (kind === 'regular' && declaresDecoratedMember(declarationFiles, componentName, key)) continue;
          diagnostics.push({
            file: relFile,
            line: j + 1,
            column: 1,
            severity: 'error',
            rule: kind === 'local' ? 'local-property-init' : 'regular-property-init',
            message:
              kind === 'local'
                ? `The '@Local' property '${key}' in the custom component '${componentName}' cannot be initialized here (forbidden to specify). '@Local' is component-private state; change '${key}' to '@Param' in '${componentName}' if the parent must supply it, or drop it from this call site.`
                : `The 'regular' property '${key}' in the custom component '${componentName}' cannot be initialized here (forbidden to specify). '${key}' is declared without a decorator in the '@ComponentV2' struct '${componentName}'; decorate it with '@Param' so the parent can pass it.`,
          });
        }

        if (started && depth <= 0) break;
      }
    }
  }
  return diagnostics;
}

// An @Entry component's build() must contain exactly one root node, and that
// node must be a container (10905210). Two adjacent top-level components, or a
// single non-container like Image, both fail the build. Counting top-level
// statements inside build() is a brace-depth question, not a typing one.
//
// hvigor does NOT curate a container list: component_map.js sorts every entry of
// ets-loader/components/*.json by its own `atomic` flag into AUTOMIC_COMPONENT vs
// BUILDIN_CONTAINER_COMPONENT, and checkContainer() tests the latter. So this set
// is that derivation -- every non-atomic component in the SDK's component
// descriptors (API 20) -- not a hand-picked subset. Hand-picking is what made
// `Text() { ... }` as an @Entry root a false error: Text is non-atomic (it takes
// Span/ImageSpan children) and hvigor accepts it as the root, as do Button,
// Checkbox, Menu, Select, Toggle and ~40 others the curated list omitted. Four
// names it wrongly INCLUDED (AlphabetIndexer, ContentSlot, NodeContainer,
// RemoteWindow) are atomic and are now correctly absent. Regenerate from the SDK
// rather than editing by hand; XComponent is container-capable only with an
// object-literal argument, a distinction this line-based check cannot make and
// deliberately resolves in the permissive direction.
const CONTAINER_COMPONENTS = new Set([
  'ArcList', 'ArcListItem', 'ArcScrollBar', 'ArcSwiper', 'Badge', 'Button', 'Calendar', 'Canvas',
  'Checkbox', 'CheckboxGroup', 'ColorPicker', 'ColorPickerDialog', 'Column', 'ColumnSplit',
  'ContainerSpan', 'Counter', 'DataPanel', 'DatePicker', 'EffectComponent', 'Flex', 'FlowItem',
  'FolderStack', 'FormLink', 'Gauge', 'Grid', 'GridCol', 'GridContainer', 'GridItem', 'GridRow',
  'Hyperlink', 'IsolatedComponent', 'LazyVGridLayout', 'List', 'ListItem', 'ListItemGroup', 'Menu',
  'MenuItem', 'MenuItemGroup', 'NavDestination', 'NavRouter', 'Navigation', 'Navigator', 'Option',
  'Panel', 'Piece', 'PluginComponent', 'QRCode', 'Rating', 'Refresh', 'RelativeContainer',
  'Repeat', 'RootScene', 'Row', 'RowSplit', 'Screen', 'Scroll', 'ScrollBar', 'Section', 'Select',
  'Shape', 'Sheet', 'SideBarContainer', 'Stack', 'Stepper', 'StepperItem', 'Swiper', 'TabContent',
  'Tabs', 'Text', 'TextClock', 'TextPicker', 'TextTimer', 'TimePicker', 'Toggle', 'ToolBarItem',
  'WaterFlow', 'WindowScene', 'WithTheme', 'XComponent', 'XComponentNode',
]);

// The API surface the checker type-checks against, read from the project's own
// build-profile.json5 instead of assumed.
//
// runChecker used to hardcode `sdkInfo: '5.0.0'`, `compatibleSdkVersion: 12` and
// `runtimeOS: 'OpenHarmony'`. Every project in an observed 26-task run declared
// `6.1.1(24)` and `HarmonyOS`, so the checker was resolving a different API
// surface than the build -- which is exactly the shape of a check that passes on
// code the build then rejects for a missing member. Whether it explains any
// specific miss is unverified (that needs a DevEco SDK to test), but passing the
// project's real values removes the discrepancy either way.
//
// `compatibleSdkVersion` comes in two forms: a bare API number (`12`) and the
// versioned form (`"6.1.1(24)"`), where the parenthesised number is the API
// level. When the field is absent or unrecognised, falls back to the SDK's own
// `oh-uni-package.json` `apiVersion` — the API level the installed SDK actually
// targets — instead of a hardcoded 12 that produces false-positive version
// warnings.
const DEFAULT_SDK_INFO = '5.0.0';
const DEFAULT_RUNTIME_OS = 'OpenHarmony';

function parseCompatibleSdkVersion(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { apiLevel: raw, sdkInfo: undefined };
  }
  if (typeof raw !== 'string') {
    return { apiLevel: undefined, sdkInfo: undefined };
  }
  // `"6.1.1(24)"` -> API 24, SDK 6.1.1.
  const versioned = /^\s*(\d+(?:\.\d+)*)\s*\(\s*(\d+)\s*\)\s*$/.exec(raw);
  if (versioned) {
    return { apiLevel: Number(versioned[2]), sdkInfo: versioned[1] };
  }
  // A bare number in string form (`"12"`).
  const bare = /^\s*(\d+)\s*$/.exec(raw);
  if (bare) {
    return { apiLevel: Number(bare[1]), sdkInfo: undefined };
  }
  return { apiLevel: undefined, sdkInfo: undefined };
}

// Reads the `apiVersion` field from the bundled OpenHarmony SDK's
// `oh-uni-package.json`. This is the API level the installed SDK targets, and
// is the correct fallback when a project's build-profile.json5 doesn't declare
// `compatibleSdkVersion`.
function readSdkApiLevel(sdkDir) {
  if (!sdkDir) return undefined;
  const candidates = [
    path.join(sdkDir, 'ets', 'oh-uni-package.json'),
  ];
  for (const p of candidates) {
    try {
      const content = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (content && content.apiVersion !== undefined) {
        return Number(content.apiVersion);
      }
    } catch { /* try next candidate */ }
  }
  return undefined;
}

function readProjectSdkConfig(projectPath, sdkDir) {
  const profilePath = path.join(projectPath, 'build-profile.json5');
  let parsed = null;
  try {
    parsed = parseJson5Loose(fs.readFileSync(profilePath, 'utf-8'));
  } catch {
    parsed = null;
  }

  const products = parsed && parsed.app && Array.isArray(parsed.app.products) ? parsed.app.products : [];
  // `default` is the product hvigor builds unless told otherwise, and it is the
  // one whose SDK the check should match; fall back to the first declared.
  const product = products.find((p) => p && p.name === 'default') || products[0] || null;

  const { apiLevel, sdkInfo } = parseCompatibleSdkVersion(product ? product.compatibleSdkVersion : undefined);
  const runtimeOS = product && typeof product.runtimeOS === 'string' && product.runtimeOS
    ? product.runtimeOS
    : DEFAULT_RUNTIME_OS;

  // When the project profile doesn't declare compatibleSdkVersion (or the value
  // can't be parsed), fall back to the installed SDK's apiVersion. This avoids
  // false-positive "supported since SDK version X" warnings that arise when the
  // checker defaults to a low hardcoded API level.
  let resolvedApiLevel = apiLevel;
  if (resolvedApiLevel === undefined) {
    resolvedApiLevel = readSdkApiLevel(sdkDir);
  }

  return {
    sdkInfo: sdkInfo || DEFAULT_SDK_INFO,
    compatibleSdkVersion: resolvedApiLevel,
    runtimeOS,
  };
}

// 10905227: a custom struct may not take the name of a built-in component. The
// name resolves to the SDK component, so the struct is unreachable and every use
// type-checks against the wrong thing -- which is why the build usually reports a
// second, more confusing error alongside it (a `ColorPicker` struct also drew
// `Cannot find name 'ColorPickerAttribute'`, and that one disappeared on rename).
//
// hvigor tests INNER_COMPONENT_NAMES, which component_map.js fills with EVERY key
// of ets-loader/components/*.json regardless of `atomic`. Together with
// CONTAINER_COMPONENTS (the non-atomic half) this set -- the atomic half -- is that
// full list, derived rather than curated. The previous hand-picked version both
// missed real collisions and invented five that do not exist: Chip, ChipGroup,
// CalendarPickerDialog, MovingPhotoView and SecurityUIExtensionComponent are not
// built-in components at all but ordinary exports from `@ohos.arkui.advanced.*` /
// `@ohos.multimedia.movingphotoview`, so a struct may legally take those names and
// flagging them blocked a name the compiler accepts. Regenerate from the SDK
// component descriptors rather than editing by hand.
const BUILTIN_LEAF_COMPONENTS = new Set([
  'AbilityComponent', 'AlphabetIndexer', 'Animator', 'ArcAlphabetIndexer', 'Blank',
  'CalendarPicker', 'Camera', 'Circle', 'Component3D', 'ContentSlot', 'Divider', 'DotMatrix',
  'Ellipse', 'EmbeddedComponent', 'FormComponent', 'FrictionMotion', 'GeometryView', 'Image',
  'ImageAnimator', 'ImageSpan', 'IndicatorComponent', 'Line', 'LoadingProgress', 'LocationButton',
  'Marquee', 'MediaCachedImage', 'NodeContainer', 'PageTransitionEnter', 'PageTransitionExit',
  'Particle', 'PasteButton', 'Path', 'PatternLock', 'Polygon', 'Polyline', 'Progress', 'Radio',
  'Rect', 'RemoteWindow', 'RichEditor', 'RichText', 'SaveButton', 'ScrollMotion', 'Search',
  'Slider', 'Span', 'SpringMotion', 'SpringProp', 'SymbolGlyph', 'SymbolSpan', 'TextArea',
  'TextInput', 'UIExtensionComponent', 'Video', 'Web',
]);

function isBuiltinComponentName(name) {
  return CONTAINER_COMPONENTS.has(name) || BUILTIN_LEAF_COMPONENTS.has(name);
}

function validateStructNameCollisions(files, projectPath) {
  const diagnostics = [];
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    const relFile = path.relative(projectPath, filePath);

    for (const struct of collectStructs(lines)) {
      if (!isBuiltinComponentName(struct.name)) continue;
      // hvigor reports a 0-based column here, unlike its 1-based lines. Matching
      // it matters: the intended workflow is to diff a check against a build and
      // see the same coordinates, and an off-by-one reads as a different finding.
      const column = lines[struct.lineIdx].indexOf(struct.name);
      diagnostics.push({
        file: relFile,
        line: struct.lineIdx + 1,
        column,
        severity: 'error',
        rule: 'struct-name-builtin-collision',
        message: `The struct '${struct.name}' cannot have the same name as the built-in component '${struct.name}'. Rename the struct (for example '${struct.name}View' or a name describing its role) and update every use, including any '${struct.name}Attribute' reference.`,
      });
    }
  }
  return diagnostics;
}

function validateEntryBuildRootNode(files, projectPath) {
  const diagnostics = [];
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    const relFile = path.relative(projectPath, filePath);
    const structs = collectStructs(lines);

    for (let s = 0; s < structs.length; s++) {
      const { lineIdx, name, inline } = structs[s];
      const decorators = collectStructDecorators(lines, lineIdx, inline);
      if (!decorators.has('Entry')) continue;

      const bodyEnd = s + 1 < structs.length ? structs[s + 1].lineIdx : lines.length;
      // Locate this struct's own build() (not a nested @Builder method).
      let buildLine = -1;
      for (let i = lineIdx + 1; i < bodyEnd; i++) {
        if (/^\s*build\s*\(\s*\)\s*\{/.test(lines[i])) { buildLine = i; break; }
      }
      if (buildLine < 0) continue;

      // Walk build()'s body, collecting the component names that appear at brace
      // depth 1 (its immediate children).
      let depth = 1;
      const roots = [];
      for (let i = buildLine + 1; i < bodyEnd && depth > 0; i++) {
        const trimmed = lines[i].trim();
        if (depth === 1 && trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('.') && !trimmed.startsWith('}')) {
          const comp = /^([A-Z][\w$]*)\s*[({]/.exec(trimmed);
          if (comp) roots.push({ name: comp[1], line: i + 1 });
        }
        for (const ch of lines[i]) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
      }

      if (roots.length === 0) continue; // empty/unparsed build() — not ours to judge
      if (roots.length > 1) {
        diagnostics.push({
          file: relFile,
          line: roots[1].line,
          column: 1,
          severity: 'error',
          rule: 'entry-build-root-node',
          message: `In an '@Entry' decorated component, the 'build' method can have only one root node, which must be a container component. Struct '${name}' has ${roots.length} root nodes (${roots.map((r) => r.name).join(', ')}); wrap them in a single container such as Column or Stack.`,
        });
      } else if (!CONTAINER_COMPONENTS.has(roots[0].name)) {
        diagnostics.push({
          file: relFile,
          line: roots[0].line,
          column: 1,
          severity: 'error',
          rule: 'entry-build-root-node',
          message: `In an '@Entry' decorated component, the 'build' method can have only one root node, which must be a container component. Struct '${name}' has a single root '${roots[0].name}', which is not a container; wrap it in a container such as Column or Stack.`,
        });
      }
    }
  }
  return diagnostics;
}

// 10905209: inside a `build()` or `@Builder` body, only UI component syntax may
// appear. A local `const`/`let`/`var` there is ordinary, type-correct ArkTS — the
// standalone checker accepts it happily — but hvigor's UI transform rejects it,
// so the whole build fails on code that passed arkts_check cleanly.
//
// Only two unambiguous shapes are flagged, and only at a UI statement position:
// a local declaration, and a loop/switch statement. ArkUI's UI syntax admits
// `if`/`else` and `ForEach`/`LazyForEach` — never `for`/`while`/`do`/`switch` —
// so those are safe to reject; other expression statements are left alone
// because a bare component call looks the same to a line-based check.
//
// Statements inside a nested JS scope (an `.onClick(() => { const x = ... })`
// handler, a `.key(item => item.id)` generator) are legal and must not be
// flagged, so the walk keeps a scope stack: a brace opened by a line carrying
// `=>` or `function` starts a JS scope, any other brace continues the UI scope.
//
// The exception is the item-builder callback of a list renderer. `ForEach`,
// `LazyForEach` and `Repeat().each()/.template()` take an arrow whose body is
// still UI-syntax-only — hvigor rejects a `let`/`for` there with 10905209 just
// as it does directly inside `build()`. Treating that arrow as a JS scope is
// what let `let club: ClubInfo = item as ClubInfo` inside a `ForEach` reach the
// build across several observed projects, so those callbacks keep the UI scope.
const BUILDER_LOCAL_DECL_RE = /^\s*(const|let|var)\s+[A-Za-z_$[{]/;
const BUILDER_NON_UI_STATEMENT_RE = /^\s*(for|while|do|switch)\s*[({]/;

// A line that opens the item-builder callback of a list renderer. The arrow and
// the brace it opens must both sit on this line: `ForEach(list, (item: T) => {`.
// A key generator (`(item: T) => item.id`) opens no brace and so never matches,
// and one written as a block (`.key((s: Song): string => { return s.id })`) is
// not an item builder — hence matching on the renderer call, not on `=>` alone.
const UI_ITEM_BUILDER_RE = /(?:\b(?:ForEach|LazyForEach)\s*\(|\.\s*(?:each|template)\s*\()/;

// A `build()` / `@Builder`-decorated function or method header, i.e. the lines
// whose body is UI-syntax-only.
function collectBuilderBodies(lines) {
  const bodies = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*build\s*\(\s*\)\s*\{/.test(lines[i])) {
      bodies.push({ lineIdx: i, kind: 'build' });
      continue;
    }
    // `@Builder` inline (`@Builder foo() {`) or on the preceding line.
    const inlineBuilder = /^\s*@Builder\b/.test(lines[i]);
    const prevBuilder = i > 0 && /^\s*@Builder\s*$/.test(lines[i - 1]);
    if (!inlineBuilder && !prevBuilder) continue;
    // The header may be the same line as an inline `@Builder`, or the line after
    // a standalone one. Both the free-function and struct-method forms count.
    const header = /\)\s*(?::[^{]+)?\{\s*$/.test(lines[i]) ? i : -1;
    if (header >= 0) bodies.push({ lineIdx: header, kind: 'builder' });
  }
  return bodies;
}

function validateBuilderBodyStatements(files, projectPath) {
  const diagnostics = [];
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    const relFile = path.relative(projectPath, filePath);

    for (const body of collectBuilderBodies(lines)) {
      // 'ui' for the body's own scope; each nested brace pushes 'ui' or 'js'.
      const scopes = ['ui'];
      for (let i = body.lineIdx + 1; i < lines.length && scopes.length > 0; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (scopes[scopes.length - 1] === 'ui' && !trimmed.startsWith('//')) {
          const where = body.kind === 'build' ? 'build()' : '@Builder';
          const isDecl = BUILDER_LOCAL_DECL_RE.test(line);
          const isLoop = BUILDER_NON_UI_STATEMENT_RE.test(line);
          if (isDecl || isLoop) {
            diagnostics.push({
              file: relFile,
              line: i + 1,
              column: 1,
              severity: 'error',
              rule: 'builder-body-ui-only',
              message: isDecl
                ? `Only UI component syntax can be written here. A local variable declaration is not allowed directly inside a '${where}' body; compute the value in a regular method or getter (or a private field) and reference it here instead.`
                : `Only UI component syntax can be written here. A '${trimmed.split(/[\s({]/)[0]}' statement is not allowed directly inside a '${where}' body; use 'ForEach'/'LazyForEach' to render a list, or move the loop into a regular method that returns the data.`,
            });
          }
        }
        // A brace opened on a line carrying `=>`/`function` starts a JS scope
        // where ordinary statements are legal -- unless the arrow is the item
        // builder of a list renderer, whose body stays UI-syntax-only.
        //
        // Known limitation: a single line opening both an item builder and an
        // event callback (`ForEach(l, (i: T) => { Button().onClick(() => {`)
        // gets one verdict for both braces, and UI wins. That direction risks a
        // false positive on the handler rather than missing the item builder;
        // splitting it needs an expression-level parse, not a line scan.
        const js = /=>|(?:^|[^\w.$])function\b/.test(line) && !UI_ITEM_BUILDER_RE.test(line);
        for (const ch of line) {
          if (ch === '{') scopes.push(js ? 'js' : scopes[scopes.length - 1]);
          else if (ch === '}') scopes.pop();
        }
      }
    }
  }
  return diagnostics;
}

// Single-file V1/V2 member-decorator rules that the ArkTS linter accepts but
// hvigor rejects. Each is a local, syntactic judgement about one member line.
// --- Navigation runtime correctness ---
// These three shapes all compile cleanly and all fail only at runtime, as a
// white screen or a wrong page. The checker cannot see them because each is a
// legal call; what is wrong is the semantics.

// `.navDestination(builder)` is a property method, not an event subscription:
// calling it more than once on the same Navigation replaces the registration
// rather than adding to it, so only the LAST builder is ever used and every
// pushPath renders that one page regardless of its name.
function validateNavDestinationRegistration(files, projectPath) {
  const diagnostics = [];
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    const relFile = path.relative(projectPath, filePath);

    // Attribute chains attach to the Navigation() they follow, so grouping by
    // the nearest preceding Navigation() keeps two separate Navigations in one
    // file from being merged into a false positive.
    let navLine = -1;
    const hits = [];
    const flush = () => {
      if (hits.length > 1) {
        diagnostics.push({
          file: relFile,
          line: hits[1].line,
          column: 1,
          severity: 'error',
          rule: 'nav-destination-single-builder',
          message:
            `'.navDestination' is a property method, so chaining it ${hits.length} times does not register ${hits.length} routes — ` +
            `each call replaces the previous one and only the last builder ('${hits[hits.length - 1].builder}') is ever used, ` +
            `making every pushPath open that page. Call '.navDestination' once with a single @Builder that dispatches on the ` +
            `route name: '@Builder routeMap(name: string, param: object) { if (name === \'A\') { ... } else if (name === \'B\') { ... } }'.`,
        });
      }
      hits.length = 0;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('//')) continue;
      if (/\bNavigation\s*\(/.test(line)) {
        flush();
        navLine = i;
      }
      const m = /^\s*\.navDestination\s*\(\s*(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)/.exec(line);
      if (m && navLine >= 0) hits.push({ line: i + 1, builder: m[1] });
    }
    flush();
  }
  return diagnostics;
}

// `.hideNavBar(true)` hides the whole navigation bar area — title bar, TOOLBAR
// AND the Navigation's own content child. When the home page is written inside
// `Navigation { ... }`, that blanks the launch screen. `.hideTitleBar(true)` is
// what "remove the system title" means.
function validateHideNavBarUsage(files, projectPath) {
  const diagnostics = [];
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    const relFile = path.relative(projectPath, filePath);

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('//')) continue;
      if (!/^\s*\.hideNavBar\s*\(\s*true\s*\)/.test(lines[i])) continue;

      // Only a Navigation that actually has a content child loses something.
      // Find the Navigation this chain belongs to and check whether its body
      // holds a component rather than being empty.
      let navIdx = -1;
      for (let j = i; j >= 0; j--) {
        if (/\bNavigation\s*\(/.test(lines[j])) { navIdx = j; break; }
      }
      if (navIdx < 0) continue;
      if (!/\{\s*$/.test(lines[navIdx])) continue;

      const state = { quote: null, inBlockComment: false };
      const bodyEnd = findStructBodyEnd(lines, navIdx, state);
      let hasChild = false;
      for (let j = navIdx + 1; j < bodyEnd && j < lines.length; j++) {
        const trimmed = lines[j].trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('.') || trimmed.startsWith('}')) continue;
        if (/^([A-Z][\w$]*)\s*[({]/.test(trimmed)) { hasChild = true; break; }
      }
      if (!hasChild) continue;

      diagnostics.push({
        file: relFile,
        line: i + 1,
        column: 1,
        severity: 'error',
        rule: 'hide-nav-bar-hides-content',
        message:
          `'.hideNavBar(true)' hides the entire navigation bar — title bar, tool bar AND the content written inside ` +
          `'Navigation { ... }' — so this page renders blank at runtime even though it compiles. ` +
          `Use '.hideTitleBar(true)' to remove only the system title, and delete '.hideNavBar(true)'.`,
      });
    }
  }
  return diagnostics;
}

// A route builder branch must produce a `NavDestination` root. Pushing to a
// branch that renders a bare business component leaves the destination with no
// mountable root, which shows as a white screen after pushPath.
//
// There are two correct shapes and both must pass: the builder wraps its
// branches itself, OR the target page uses NavDestination as its own build()
// root. Only a branch that satisfies neither is reported, so the component is
// resolved across the project before judging it.
function collectNavDestinationRootComponents(files, projectPath) {
  const names = new Set();
  const declarationFiles = projectPath ? unionProjectFiles(files, projectPath) : files;
  for (const filePath of declarationFiles) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    const structs = collectStructs(lines);
    for (const { lineIdx, name } of structs) {
      const state = { quote: null, inBlockComment: false };
      const bodyEnd = findStructBodyEnd(lines, lineIdx, state);
      for (let i = lineIdx + 1; i < bodyEnd && i < lines.length; i++) {
        if (!/^\s*build\s*\(\s*\)\s*\{/.test(lines[i])) continue;
        // First component named in build() is its root node.
        for (let j = i + 1; j < bodyEnd && j < lines.length; j++) {
          const trimmed = lines[j].trim();
          if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('.')) continue;
          const comp = /^([A-Z][\w$]*)\s*[({]/.exec(trimmed);
          if (comp) {
            if (comp[1] === 'NavDestination') names.add(name);
            break;
          }
          break;
        }
        break;
      }
    }
  }
  return names;
}

function validateNavDestinationRoot(files, projectPath) {
  const diagnostics = [];
  const wrappedPages = collectNavDestinationRootComponents(files, projectPath);
  // Components the project itself declares. A branch rendering anything else
  // (a library page, an unresolvable import) cannot be judged: its root node is
  // not in the sources we can read, so staying silent is the only safe choice.
  const localComponents = new Set();
  const declarationFiles = projectPath ? unionProjectFiles(files, projectPath) : files;
  for (const declFile of declarationFiles) {
    let declContent;
    try { declContent = fs.readFileSync(declFile, 'utf-8'); } catch { continue; }
    for (const { name } of collectStructs(declContent.split('\n'))) localComponents.add(name);
  }

  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    const relFile = path.relative(projectPath, filePath);

    // Only builders actually registered as a route map are subject to this.
    const registered = new Set();
    for (const line of lines) {
      const m = /\.navDestination\s*\(\s*(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)/.exec(line);
      if (m) registered.add(m[1]);
    }
    if (registered.size === 0) continue;

    for (let i = 0; i < lines.length; i++) {
      const header = /^\s*(?:@Builder\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/.exec(lines[i]);
      if (!header || !registered.has(header[1])) continue;
      const isBuilder = /^\s*@Builder\b/.test(lines[i]) || (i > 0 && /^\s*@Builder\s*$/.test(lines[i - 1]));
      if (!isBuilder) continue;

      const state = { quote: null, inBlockComment: false };
      const bodyEnd = findStructBodyEnd(lines, i, state);
      let mentionsND = false;
      const branches = [];
      for (let j = i + 1; j < bodyEnd && j < lines.length; j++) {
        const trimmed = lines[j].trim();
        if (!trimmed || trimmed.startsWith('//')) continue;
        if (/\bNavDestination\s*\(/.test(trimmed)) { mentionsND = true; break; }
        // Match both `Page(...)` and `Container() {` so a container opening a
        // block is recognized as the root rather than skipped, which would let
        // one of its children be reported instead.
        const comp = /^([A-Z][\w$]*)\s*[({]/.exec(trimmed);
        if (!comp) continue;
        const name = comp[1];
        // A container root means this branch builds its own subtree — that is a
        // missing NavDestination, but the container IS the root, so stop here
        // rather than descending into its children.
        if (CONTAINER_COMPONENTS.has(name)) { branches.push({ line: j + 1, name }); break; }
        if (wrappedPages.has(name)) continue;
        if (!localComponents.has(name)) continue;
        branches.push({ line: j + 1, name });
      }
      if (mentionsND || branches.length === 0) continue;

      const target = branches[0];
      const isContainer = CONTAINER_COMPONENTS.has(target.name);
      diagnostics.push({
        file: relFile,
        line: target.line,
        column: 1,
        severity: 'error',
        rule: 'nav-destination-root-node',
        message:
          `Route builder '${header[1]}' renders '${target.name}' without a 'NavDestination' root, so pushing this route ` +
          `shows a white screen at runtime even though it compiles. ` +
          (isContainer
            ? `Wrap this branch's content as 'NavDestination() { ${target.name}() { ... } }'.`
            : `Wrap each branch as 'NavDestination() { ${target.name}(...) }', or make 'NavDestination' the root node of ` +
              `that page's own build().`),
      });
    }
  }
  return diagnostics;
}

// V1 `AppStorage` cannot store a V2 (`@ObservedV2`) class instance: the call
// throws at startup, so the app crashes on launch. V2 state belongs in
// `AppStorageV2.connect` / `PersistenceV2.connect`.
function validateAppStorageV2Mixing(files, projectPath) {
  // Only a class the project itself decorates '@ObservedV2' crashes here, which is
  // exactly what this index holds while SDK_OBSERVED_V2_CLASSES stays empty. If a
  // name is ever seeded there, re-check whether it also crashes AppStorage before
  // letting it reach this rule.
  const observedV2Classes = collectObservedV2ClassNames(files, projectPath);
  if (observedV2Classes.size === 0) return [];

  const diagnostics = [];
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    const relFile = path.relative(projectPath, filePath);

    // Local `name: Type` declarations, so a bare `this.viewModel` argument can
    // be resolved back to its @ObservedV2 class.
    const declaredTypes = new Map();
    for (const line of lines) {
      const decl = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:private\s+|readonly\s+|public\s+)*([A-Za-z_$][\w$]*)\s*(?:\?|!)?\s*:\s*([A-Za-z_$][\w$]*)\s*=/.exec(line);
      if (decl) declaredTypes.set(decl[1], decl[2]);
    }

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('//')) continue;
      const call = /AppStorage\s*\.\s*setOrCreate\s*(?:<\s*([A-Za-z_$][\w$]*)\s*>)?\s*\(\s*([^,]+),\s*([^),]+)/.exec(lines[i]);
      if (!call) continue;

      const explicit = call[1];
      const argExpr = call[3].trim();
      const argName = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(argExpr);
      const newed = /^new\s+([A-Za-z_$][\w$]*)/.exec(argExpr);
      const resolved =
        (explicit && observedV2Classes.has(explicit) && explicit) ||
        (newed && observedV2Classes.has(newed[1]) && newed[1]) ||
        (argName && observedV2Classes.has(declaredTypes.get(argName[1])) && declaredTypes.get(argName[1]));
      if (!resolved) continue;

      diagnostics.push({
        file: relFile,
        line: i + 1,
        column: 1,
        severity: 'error',
        rule: 'appstorage-observedv2-mixing',
        message:
          `'AppStorage.setOrCreate' cannot store '${resolved}', which is decorated '@ObservedV2': V1 AppStorage and V2 ` +
          `observation cannot be mixed and this throws at startup, crashing the app on launch. ` +
          `Use 'AppStorageV2.connect(${resolved}, 'key', () => new ${resolved}())' (or 'PersistenceV2.connect' to persist).`,
      });
    }
  }
  return diagnostics;
}

function validateV2MemberDecoratorRules(files, projectPath) {
  const diagnostics = [];
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    const relFile = path.relative(projectPath, filePath);

    for (let i = 0; i < lines.length; i++) {
      // 10905363: a V1 @Prop/@Link/@State cannot hold a function-typed value.
      const v1Fn = /^\s*@(Prop|Link|State)\b(?:\([^)]*\))?\s+([A-Za-z_$][\w$]*)\s*(?:\?|!)?\s*:\s*(\([^)]*\)\s*=>|Function\b)/.exec(lines[i]);
      if (v1Fn) {
        diagnostics.push({
          file: relFile,
          line: i + 1,
          column: 1,
          severity: 'error',
          rule: 'v1-decorator-function-type',
          message: `The V1 decorator '@${v1Fn[1]}' cannot be applied to a Function-type variable '${v1Fn[2]}'. Use '@Param' in a '@ComponentV2' struct, or declare it as a plain callback member and pass it via a builder/arrow property instead.`,
        });
        continue;
      }

      // 10905327: @Param without a default value must also carry @Require.
      const param = /^\s*@Param\b(?:\([^)]*\))?\s+([A-Za-z_$][\w$]*)\s*(?:\?)?\s*:\s*([^=]+)$/.exec(lines[i].replace(/\/\/.*$/, '').trimEnd());
      if (param && !/\?\s*:/.test(lines[i])) {
        // @Require may sit inline before @Param or on the preceding line.
        const inlineRequire = /@Require\b/.test(lines[i]);
        const prevRequire = i > 0 && /^\s*@Require\s*$/.test(lines[i - 1]);
        if (!inlineRequire && !prevRequire) {
          diagnostics.push({
            file: relFile,
            line: i + 1,
            column: 1,
            severity: 'error',
            rule: 'param-requires-require',
            message: `When a variable decorated with '@Param' is not assigned a default value, it must also be decorated with '@Require'. Add '@Require' to '${param[1]}', or give it a default value.`,
          });
        }
      }
    }
  }
  return diagnostics;
}

// 10905307: @ObjectLink's type must be a class decorated with @Observed/@ObservedV2.
//
// NOT WIRED INTO computeProjectDiagnostics. The naive form of this rule ("type
// is a project class without @Observed -> error") fires on code that hvigor
// accepts: a bootstrap project that builds successfully has `@ObjectLink task:
// HealthTask` where HealthTask carries no @Observed at all. Whatever makes that
// legal (inherited decoration, a V2 container path, or a laxer check than the
// error message implies) is not captured here, and one real failure is not worth
// a false positive on passing code. Kept — exported for tests — so the next
// attempt starts from the known-insufficient version rather than from scratch.
const OBJECT_LINK_TYPE_RE = /^\s*@ObjectLink\b(?:\([^)]*\))?\s+([A-Za-z_$][\w$]*)\s*(?:\?|!)?\s*:\s*([A-Za-z_$][\w$]*)\b(?!\s*[<[.])/;

function collectObservedClassNames(files) {
  const names = new Set();
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = CLASS_DECL_RE.exec(lines[i]);
      if (!m) continue;
      const decorators = collectStructDecorators(lines, i, m[2]);
      if (decorators.has('Observed') || decorators.has('ObservedV2')) names.add(m[3]);
    }
  }
  return names;
}

function validateObjectLinkTypes(files, projectPath) {
  const declarationFiles = projectPath ? unionProjectFiles(files, projectPath) : files;
  const observed = collectObservedClassNames(declarationFiles);
  // Class declarations we can see at all — only judge types declared in-project,
  // so an SDK or third-party type is never guessed at.
  const declared = new Set();
  for (const filePath of declarationFiles) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    for (const line of content.split('\n')) {
      const m = CLASS_DECL_RE.exec(line);
      if (m) declared.add(m[3]);
    }
  }

  const diagnostics = [];
  for (const filePath of files) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    const relFile = path.relative(projectPath, filePath);
    for (let i = 0; i < lines.length; i++) {
      const m = OBJECT_LINK_TYPE_RE.exec(lines[i]);
      if (!m) continue;
      const typeName = m[2];
      if (!declared.has(typeName)) continue; // not a project class -> out of scope
      if (observed.has(typeName)) continue;
      diagnostics.push({
        file: relFile,
        line: i + 1,
        column: 1,
        severity: 'error',
        rule: 'object-link-observed-type',
        message: `'@ObjectLink' cannot be used with this type. Apply it only to classes decorated by '@Observed' or '@ObservedV2'. '${typeName}' has neither; add '@Observed' to the class, or use a different state decorator for '${m[1]}'.`,
      });
    }
  }
  return diagnostics;
}

function validateModelVersion(projectPath) {
  const hvigorPath = path.join(projectPath, 'hvigor', 'hvigor-config.json5');
  const ohPkgPath = path.join(projectPath, 'oh-package.json5');
  if (!fs.existsSync(hvigorPath) || !fs.existsSync(ohPkgPath)) return [];

  const extractVersion = (file) => {
    const content = fs.readFileSync(file, 'utf-8');
    const m = content.match(/["']?modelVersion["']?\s*:\s*["']([^"']+)["']/);
    return m ? m[1] : null;
  };

  const hvigorVer = extractVersion(hvigorPath);
  const ohPkgVer = extractVersion(ohPkgPath);

  if (hvigorVer && ohPkgVer && hvigorVer !== ohPkgVer) {
    return [{
      file: 'hvigor/hvigor-config.json5',
      line: 1,
      column: 1,
      severity: 'error',
      message: `modelVersion mismatch: hvigor-config.json5 has '${hvigorVer}' but oh-package.json5 has '${ohPkgVer}'. They must be consistent.`,
      rule: 'model-version-consistency',
    }];
  }
  return [];
}

// --- user_grant permission config validation ---
//
// Permissions are split into `system_grant` (auto-granted at install) and
// `user_grant` (runtime dialog). For every `user_grant` permission declared in
// module.json5's `requestPermissions`, hvigor REQUIRES a `reason` that is a
// `$string:` resource reference; a missing/literal `reason` fails the build.
// `usedScene` is optional since API 9, so we only warn when it is absent.
// The linter never reads module.json5's permission block, so we add it here.

// Parse a JSON5-ish document (comments + trailing commas) into an object, or
// null on failure. Comment stripping is string-literal aware so a `//` inside a
// value is preserved. Deliberately minimal — enough for module.json5 configs.
function parseJson5Loose(text) {
  try {
    let out = '';
    let inStr = false;
    let quote = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const next = text[i + 1];
      if (inStr) {
        out += c;
        if (c === '\\') { out += next; i++; continue; }
        if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
      if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
      if (c === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
      out += c;
    }
    // Single-quoted strings -> double-quoted; drop trailing commas.
    out = out.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner) => '"' + inner.replace(/"/g, '\\"') + '"');
    out = out.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// Set of `$string:` keys defined in a string.json document, or null if the
// document is missing/unparseable (in which case key-existence isn't checked).
function loadStringResourceKeys(stringJsonText) {
  if (stringJsonText == null) return null;
  const parsed = parseJson5Loose(stringJsonText);
  if (!parsed || !Array.isArray(parsed.string)) return null;
  const keys = new Set();
  for (const entry of parsed.string) {
    if (entry && typeof entry.name === 'string') keys.add(entry.name);
  }
  return keys;
}

// Pure core: given the raw module.json5 text, the user_grant name set, and
// (optionally) the string.json keys, return diagnostics. `relFile` is used only
// for the diagnostic's file field. Line numbers anchor to the permission's
// `"name"` line in the raw text (fallback: line 1).
function validatePermissionsConfig(moduleJson5Text, userGrantSet, stringKeys, relFile) {
  const parsed = parseJson5Loose(moduleJson5Text);
  const perms = parsed && parsed.module && Array.isArray(parsed.module.requestPermissions)
    ? parsed.module.requestPermissions
    : null;
  if (!perms) return [];

  const lineOf = (permName) => {
    const idx = moduleJson5Text.indexOf(permName);
    if (idx < 0) return 1;
    return moduleJson5Text.slice(0, idx).split('\n').length;
  };

  const diags = [];
  for (const p of perms) {
    if (!p || typeof p.name !== 'string' || !userGrantSet.has(p.name)) continue;
    const line = lineOf(p.name);
    const base = { file: relFile, line, column: 1 };

    if (p.reason === undefined || p.reason === null || p.reason === '') {
      diags.push({ ...base, severity: 'error', rule: 'permission-reason-required',
        message: `user_grant permission '${p.name}' is missing 'reason'. It must be a $string: resource reference or the build will fail.` });
    } else if (typeof p.reason !== 'string' || !p.reason.startsWith('$string:')) {
      diags.push({ ...base, severity: 'error', rule: 'permission-reason-required',
        message: `user_grant permission '${p.name}' has an invalid 'reason' (${JSON.stringify(p.reason)}). It must be a $string: resource reference.` });
    } else if (stringKeys) {
      const key = p.reason.slice('$string:'.length);
      if (!stringKeys.has(key)) {
        diags.push({ ...base, severity: 'error', rule: 'permission-reason-resource',
          message: `user_grant permission '${p.name}' references '${p.reason}' but string resource '${key}' is not defined in string.json.` });
      }
    }

    const scene = p.usedScene;
    const sceneEmpty = scene == null ||
      (typeof scene === 'object' && (!Array.isArray(scene.abilities) || scene.abilities.length === 0) && scene.when === undefined);
    if (sceneEmpty) {
      diags.push({ ...base, severity: 'warning', rule: 'permission-usedscene-recommended',
        message: `user_grant permission '${p.name}' has no 'usedScene'. Declaring abilities/when is recommended for store review.` });
    }
  }
  return diags;
}

// Load the SDK's permission definitions from PermissionDefinitions.json, split
// into the user_grant subset (existing reason/usedScene checks) and the full
// name set across every grantMode (system_grant + user_grant), used by the
// "unknown permission name" check below. Returns { userGrant, all } or null if
// the SDK file cannot be found/parsed.
function loadSdkPermissionSets(sdkDir) {
  const candidates = [
    path.join(sdkDir, 'toolchains', 'lib', 'PermissionDefinitions.json'),
  ];
  let file = '';
  for (const c of candidates) {
    if (fs.existsSync(c)) { file = c; break; }
  }
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const list = Array.isArray(parsed.definePermissions) ? parsed.definePermissions : [];
    const userGrant = new Set();
    const all = new Set();
    for (const d of list) {
      if (!d || typeof d.name !== 'string') continue;
      all.add(d.name);
      if (d.grantMode === 'user_grant') userGrant.add(d.name);
    }
    return all.size > 0 ? { userGrant, all } : null;
  } catch {
    return null;
  }
}

// Names declared in module.json5's own `definePermissions` block (custom
// permissions this module defines for OTHER apps to request) — these are
// valid `requestPermissions` targets too, on top of the SDK-predefined set.
function loadCustomPermissionNames(parsedModuleJson5) {
  const list = parsedModuleJson5 && parsedModuleJson5.module && Array.isArray(parsedModuleJson5.module.definePermissions)
    ? parsedModuleJson5.module.definePermissions
    : [];
  const set = new Set();
  for (const d of list) {
    if (d && typeof d.name === 'string') set.add(d.name);
  }
  return set;
}

// hvigor rejects `requestPermissions` entries whose `name` is not one of the
// SDK-predefined permissions (any grantMode) or a custom name this module
// itself declares under `definePermissions` (00303221 Configuration Error).
// `validatePermissionsConfig` above only checks reason/usedScene for names
// that ARE in the user_grant set — a name that doesn't exist at all (e.g. a
// hallucinated `ohos.permission.NOTIFICATION` instead of the real
// `ohos.permission.ACCESS_NOTIFICATION_POLICY`) silently skips that check and
// only surfaces once hvigor's PreBuild step runs. This closes that gap.
function validatePermissionNamesExist(moduleJson5Text, allPermissionNames, relFile) {
  const parsed = parseJson5Loose(moduleJson5Text);
  const perms = parsed && parsed.module && Array.isArray(parsed.module.requestPermissions)
    ? parsed.module.requestPermissions
    : null;
  if (!perms) return [];

  const customNames = loadCustomPermissionNames(parsed);
  const lineOf = (permName) => {
    const idx = moduleJson5Text.indexOf(permName);
    if (idx < 0) return 1;
    return moduleJson5Text.slice(0, idx).split('\n').length;
  };

  const diags = [];
  for (const p of perms) {
    if (!p || typeof p.name !== 'string') continue;
    if (allPermissionNames.has(p.name) || customNames.has(p.name)) continue;
    diags.push({
      file: relFile,
      line: lineOf(p.name),
      column: 1,
      severity: 'error',
      rule: 'permission-name-exists',
      message: `Unknown permission '${p.name}'. It is not defined in the SDK's PermissionDefinitions.json and not declared under this module's own 'definePermissions'. The build will fail with a Configuration Error.`,
    });
  }
  return diags;
}

// Project-level entry: locate module.json5 + string.json, run the pure checkers.
function validatePermissions(projectPath, sdkDir) {
  const sdkSets = loadSdkPermissionSets(sdkDir);
  if (!sdkSets) return [];

  const moduleCandidates = [
    path.join(projectPath, 'entry', 'src', 'main', 'module.json5'),
    path.join(projectPath, 'src', 'main', 'module.json5'),
    path.join(projectPath, 'entry', 'module.json5'),
  ];
  let modulePath = '';
  for (const c of moduleCandidates) {
    if (fs.existsSync(c)) { modulePath = c; break; }
  }
  if (!modulePath) return [];

  let moduleText;
  try { moduleText = fs.readFileSync(modulePath, 'utf-8'); } catch { return []; }

  const stringPath = path.join(path.dirname(modulePath), 'resources', 'base', 'element', 'string.json');
  let stringText = null;
  try { if (fs.existsSync(stringPath)) stringText = fs.readFileSync(stringPath, 'utf-8'); } catch { /* keep null */ }

  const stringKeys = loadStringResourceKeys(stringText);
  const relFile = path.relative(projectPath, modulePath);
  return [
    ...validatePermissionNamesExist(moduleText, sdkSets.all, relFile),
    ...validatePermissionsConfig(moduleText, sdkSets.userGrant, stringKeys, relFile),
  ];
}

// --- ArkUI binding-syntax false-positive whitelist ---
//
// The standalone type checker (etsStandaloneChecker) does not expand ArkUI
// syntax sugar, so it treats binding-syntax tokens as ordinary identifiers and
// wrongly reports `Cannot find name '$...'`. Two legal forms trigger this:
//   A) `$$this.x` two-way binding (e.g. bindSheet($$this.foo), Refresh({ refreshing: $$this.bar }))
//   B) `$varName` @Link / @Builder argument passing (e.g. Child({ items: $items }))
// devecocli build (the real compiler) accepts both. We silently drop these
// false positives here. Rule B only fires when `varName` is actually declared
// as a state-decorated field in the same source file, so genuinely-undefined
// `$foo` references are still reported.

const STATE_DECORATORS = [
  'State', 'Link', 'Prop', 'ObjectLink', 'Local', 'Param', 'Provide', 'Consume',
  'StorageLink', 'StorageProp', 'LocalStorageLink', 'LocalStorageProp',
];

// State-field decorator matcher. Compiled once at module load (the pattern is
// built from the constant STATE_DECORATORS) instead of on every call. It carries
// the global flag, so reset lastIndex before each reuse.
const STATE_FIELD_RE = new RegExp(
  '@(?:' + STATE_DECORATORS.join('|') + ')(?:\\([^)]*\\))?\\s+([A-Za-z_$][\\w$]*)',
  'g',
);

// Cache: absolute source path -> Set of state-decorated field names declared in it.
const stateFieldCache = new Map();

function getStateFields(absPath) {
  if (stateFieldCache.has(absPath)) return stateFieldCache.get(absPath);
  const fields = new Set();
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    STATE_FIELD_RE.lastIndex = 0;
    let m;
    while ((m = STATE_FIELD_RE.exec(content)) !== null) {
      fields.add(m[1]);
    }
  } catch {
    // unreadable file -> empty set (conservative: rule B won't match)
  }
  stateFieldCache.set(absPath, fields);
  return fields;
}

// Returns true if the diagnostic is a binding-syntax false positive that should
// be dropped. Any parse/IO issue returns false (keep the diagnostic).
function isBindingSyntaxFalsePositive(diag, projectPath) {
  try {
    const m = /^Cannot find name '(\$[^']+)'/.exec(diag.message || '');
    if (!m) return false;
    const name = m[1];

    // Rule A: `$$...` is always ArkUI two-way binding sugar, never a plain identifier.
    if (name.startsWith('$$')) return true;

    // Rule B: `$word` -> confirm `word` is a state-decorated field in the same file.
    const bare = /^\$([A-Za-z_][\w$]*)$/.exec(name);
    if (!bare) return false;
    const fieldName = bare[1];

    const absPath = path.isAbsolute(diag.file)
      ? diag.file
      : path.resolve(projectPath, diag.file);
    return getStateFields(absPath).has(fieldName);
  } catch {
    return false;
  }
}

// --- Auto-fix (heuristic, deterministic) ---
//
// We only rewrite text the compiler has already computed for us (its
// `Did you mean 'X'?` suggestions and fixed structural rules), then re-run the
// checker to confirm the diagnostic disappeared. A fix that introduces a NEW
// error on the same file is reverted. This keeps accuracy first: a wrong guess
// self-corrects instead of silently corrupting the source.

// Suggestions that are generic Object/prototype members. The compiler offers
// these when the real bug is a type mismatch (e.g. `string.value` -> `valueOf`),
// so applying them compiles but is semantically wrong. Never auto-apply.
const GENERIC_SUGGESTION_BLACKLIST = new Set([
  'valueOf', 'toString', 'toLocaleString', 'length', 'constructor',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'name',
  'call', 'apply', 'bind',
]);

function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function offsetOf(lineStarts, line, col) {
  const base = lineStarts[line - 1];
  if (base === undefined) return -1;
  return base + (col - 1);
}

// Extract the named-binding list from a "has no default export. Did you mean to
// use 'import { X } from "..."' instead?" diagnostic, or null.
//
// The compiler resolves the module and names the exact export(s) that a default
// import should have been, so the binding text is authored by the compiler, not
// guessed here — the same trust model as extractRename. Only the BINDING is
// taken: the suggestion's specifier is the absolute resolved path
// ("E:/.../ets/model/ScanFile"), so splicing the whole statement in would
// replace a clean relative specifier with an absolute one. The diagnostic's
// column points at the default-binding identifier, which is all we rewrite.
//
// A diagnostic with no suggestion means the compiler found no candidate export;
// those are left for the model (the module may legitimately export nothing).
function extractDefaultImportBinding(message) {
  const m = /Did you mean to use 'import (\{[^}]*\}) from "[^"]*"' instead\?/.exec(message || '');
  if (!m) return null;
  const binding = m[1].trim();
  // Guard the shape we are about to write: `{ Ident }` or `{ A, B }`, nothing
  // with aliases/nesting we have not seen the compiler emit here.
  const inner = binding.slice(1, -1).trim();
  if (!inner) return null;
  if (!/^[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*$/.test(inner)) return null;
  return `{ ${inner.split(/\s*,\s*/).join(', ')} }`;
}

// Extract {bad, good} from a rename-style diagnostic, or null. `good` is
// dropped if it is a blacklisted generic member.
function extractRename(message) {
  const good = /Did you mean '([^']+)'\?/.exec(message || '');
  if (!good) return null;
  if (GENERIC_SUGGESTION_BLACKLIST.has(good[1])) return null;
  const bad =
    /Cannot find name '([^']+)'/.exec(message) ||
    /Property '([^']+)' does not exist/.exec(message) ||
    /has no exported member(?: named)? '([^']+)'/.exec(message);
  if (!bad) return null;
  return { bad: bad[1], good: good[1] };
}

// Build a list of {start, end, text, diag} edits for one file from its
// diagnostics. Structural whole-file rewrites (import hoist) are returned as a
// single edit spanning the region they change. Returns [] if nothing applies.
function buildFileEdits(content, diags, fixCtx) {
  const lineStarts = computeLineStarts(content);
  const edits = [];
  let importHoistDiags = null;
  let versionMismatchDiags = null;

  for (const d of diags) {
    // Tier 1.1: `Did you mean 'X'?` token rename.
    const rename = extractRename(d.message);
    if (rename) {
      const start = offsetOf(lineStarts, d.line, d.column);
      if (start >= 0 && content.startsWith(rename.bad, start)) {
        edits.push({ start, end: start + rename.bad.length, text: rename.good, diag: d });
      }
      continue;
    }

    // Tier 1.2: default import of a module that has only named exports ->
    // rewrite the default binding as the compiler-named named binding.
    const defaultBinding = extractDefaultImportBinding(d.message);
    if (defaultBinding) {
      const start = offsetOf(lineStarts, d.line, d.column);
      if (start >= 0) {
        // The diagnostic column sits on the default-binding identifier; replace
        // exactly that token so the original (relative) specifier survives.
        const ident = /^[A-Za-z_$][\w$]*/.exec(content.slice(start));
        if (ident) {
          edits.push({ start, end: start + ident[0].length, text: defaultBinding, diag: d });
        }
      }
      continue;
    }

    // Tier 1.3: async function must return Promise<T>.
    const promise = /Did you mean to write '(Promise<[^']*>)'/.exec(d.message || '');
    if (promise) {
      const start = offsetOf(lineStarts, d.line, d.column);
      // The annotated return type begins at the diagnostic column; replace the
      // type token (identifier + optional generic args) up to the following
      // '{' , '=>' , newline, or ')'.
      if (start >= 0) {
        const rest = content.slice(start);
        const m = /^[A-Za-z_$][\w$.]*(?:<[^{)=\n]*>)?/.exec(rest);
        if (m) edits.push({ start, end: start + m[0].length, text: promise[1], diag: d });
      }
      continue;
    }

    // Tier 1.4: import path must not end with '.ets'.
    if (/An import path cannot end with a '\.ets' extension/.test(d.message || '')) {
      const lineStart = lineStarts[d.line - 1];
      if (lineStart !== undefined) {
        const lineEnd = content.indexOf('\n', lineStart);
        const line = content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd);
        const idx = line.indexOf('.ets');
        if (idx >= 0) {
          const start = lineStart + idx;
          edits.push({ start, end: start + 4, text: '', diag: d });
        }
      }
      continue;
    }

    // Tier 1.5: V1/V2 component decorator mismatch -> flip the STRUCT's
    // decorator (not the members the diagnostics point at). Collect; the edits
    // are built once below since several member diagnostics map to one struct.
    if (/component-decorator-version-mismatch/.test(d.rule || '')) {
      (versionMismatchDiags = versionMismatchDiags || []).push(d);
      continue;
    }

    // Tier 1.6: misplaced imports -> hoist. Collect; handled once below.
    if (/arkts-no-misplaced-imports/.test(d.rule || '') ||
        /"import" statements after other statements/.test(d.message || '')) {
      (importHoistDiags = importHoistDiags || []).push(d);
      continue;
    }

    // Tier 1.6: `Cannot find module '<relative>'` where the specifier has the
    // wrong relative depth (e.g. `../../model/X` should be `../model/X`).
    // Resolve the basename against the project index; rewrite ONLY on a unique
    // match (0 or >1 => bail, left to the model). @kit/@ohos/bare specifiers are
    // out of scope. Needs fixCtx.{index, abs}; skipped when unavailable.
    if (fixCtx && fixCtx.index && fixCtx.abs && /Cannot find module '([^']+)'/.test(d.message || '')) {
      const spec = /Cannot find module '([^']+)'/.exec(d.message)[1];
      if (spec.startsWith('.')) {
        const base = path.basename(spec).replace(/\.ets$/, '');
        const candidates = fixCtx.index.get(base);
        if (candidates && candidates.length === 1 &&
            path.resolve(candidates[0]) !== path.resolve(fixCtx.abs)) {
          const newSpec = toRelativeSpecifier(path.dirname(fixCtx.abs), candidates[0]);
          if (newSpec !== spec) {
            const lineStart = lineStarts[d.line - 1];
            if (lineStart !== undefined) {
              const lineEnd = content.indexOf('\n', lineStart);
              const line = content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd);
              const q = new RegExp(`(['"])${escapeRegExp(spec)}\\1`);
              const sm = line.match(q);
              if (sm) {
                const idx = line.indexOf(sm[0]);
                edits.push({
                  start: lineStart + idx,
                  end: lineStart + idx + sm[0].length,
                  text: `${sm[1]}${newSpec}${sm[1]}`,
                  diag: d,
                });
              }
            }
          }
        }
      }
      continue;
    }
  }

  if (versionMismatchDiags) {
    edits.push(...buildComponentVersionEdits(content, versionMismatchDiags));
  }

  if (importHoistDiags) {
    const hoist = buildImportHoist(content, importHoistDiags);
    if (hoist) edits.push(hoist);
  }

  return edits;
}

// Flip a struct's `@Component` <-> `@ComponentV2` decorator when EVERY state
// member decorator it carries belongs to the other component model.
//
// `component-decorator-version-mismatch` diagnostics point at the offending
// MEMBER lines, but the correct single-token fix is on the struct declaration:
// a page written with five `@Local` members under `@Component` wants
// `@ComponentV2`, not five member rewrites. The direction is unambiguous —
// the diagnostic names both the required and the actual struct decorator, and
// across the observed corpus every struct's mismatches agreed on one target.
//
// The gate is what makes this safe: flipping affects every member of the struct,
// so if the struct ALSO carries a decorator from the version it currently
// declares (a `@State` next to a `@Local`), the author's intent is genuinely
// ambiguous and both directions break something. Those are skipped and left to
// the model. Re-parsing the file here rather than inferring membership from the
// diagnostic list keeps the gate honest about what the struct actually contains.
function buildComponentVersionEdits(content, diags) {
  const structNames = new Set();
  for (const d of diags) {
    const m = /but struct '(\w+)' is decorated with '@(\w+)'/.exec(d.message || '');
    if (m) structNames.add(m[1]);
  }
  if (structNames.size === 0) return [];

  const lines = content.split('\n');
  const structs = collectStructs(lines);

  const lineStarts = computeLineStarts(content);
  const edits = [];

  for (let s = 0; s < structs.length; s++) {
    const { lineIdx, name, inline } = structs[s];
    if (!structNames.has(name)) continue;

    const decorators = collectStructDecorators(lines, lineIdx, inline);
    const isV2 = decorators.has('ComponentV2');
    const isV1 = decorators.has('Component');
    // A struct carrying both is already malformed; not ours to guess at.
    if (isV1 === isV2) continue;

    const bodyStart = lineIdx + 1;
    const bodyEnd = s + 1 < structs.length ? structs[s + 1].lineIdx : lines.length;
    let sameVersionMembers = 0;
    let otherVersionMembers = 0;
    for (let i = bodyStart; i < bodyEnd; i++) {
      const dm = /^\s*@(\w+)\b/.exec(lines[i]);
      if (!dm) continue;
      const ownSet = isV2 ? V2_ONLY_MEMBER_DECORATORS : V1_ONLY_MEMBER_DECORATORS;
      const otherSet = isV2 ? V1_ONLY_MEMBER_DECORATORS : V2_ONLY_MEMBER_DECORATORS;
      if (ownSet.has(dm[1])) sameVersionMembers++;
      else if (otherSet.has(dm[1])) otherVersionMembers++;
    }
    // Mixed members, or nothing to move toward: leave it alone.
    if (sameVersionMembers > 0 || otherVersionMembers === 0) continue;

    // Rewrite the struct's own decorator token, wherever it sits: inline on the
    // `struct` line or on one of the decorator-only lines above it.
    const from = isV2 ? 'ComponentV2' : 'Component';
    const to = isV2 ? 'Component' : 'ComponentV2';
    // Walk the struct line, then the decorator-only lines above it (the same
    // range collectStructDecorators considers), and stop at the first exact
    // `@Component`/`@ComponentV2` token.
    let targetLine = -1;
    let col = -1;
    for (let i = lineIdx; i >= 0; i--) {
      if (i < lineIdx && !/^\s*@\w+(?:\([^)]*\))?\s*$/.test(lines[i])) break;
      const idx = lines[i].indexOf('@' + from);
      // `@Component` is a prefix of `@ComponentV2`: require a non-word char after.
      if (idx >= 0 && !/^\w/.test(lines[i].slice(idx + 1 + from.length))) {
        targetLine = i;
        col = idx;
        break;
      }
    }
    if (targetLine < 0) continue;

    const start = lineStarts[targetLine] + col;
    edits.push({
      start,
      end: start + 1 + from.length,
      text: '@' + to,
      diag: diags.filter((d) => new RegExp(`but struct '${name}' is decorated`).test(d.message || '')),
    });
  }

  return edits;
}

// Move every top-level `import ...` line to the top of the file (after any
// leading comment/copyright block), preserving original order. Returns a single
// edit rewriting the whole file, or null if nothing to move.
function buildImportHoist(content, diags) {
  const lines = content.split('\n');
  const importLineIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s.+from\s+['"].+['"];?\s*$/.test(lines[i]) ||
        /^\s*import\s+['"].+['"];?\s*$/.test(lines[i])) {
      importLineIdx.push(i);
    }
  }
  if (importLineIdx.length === 0) return null;

  // Insertion point = number of leading comment/blank lines. Hoisted imports
  // go right after that block (below any copyright header). Imports are never
  // in this leading region since the scan breaks at the first import.
  const importSet = new Set(importLineIdx);
  let insertAt = 0;
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; insertAt = i + 1; continue; }
    if (t === '') { insertAt = i + 1; continue; }
    if (t.startsWith('//')) { insertAt = i + 1; continue; }
    if (t.startsWith('/*')) { inBlock = !t.includes('*/'); insertAt = i + 1; continue; }
    break;
  }

  // Already contiguous starting right after the leading block -> nothing to do.
  const alreadyAtTop = importLineIdx.every((idx, k) => idx === insertAt + k);
  if (alreadyAtTop) return null;

  // Strip leading indentation (hoisted imports sit at column 0) and trailing
  // spaces/tabs, but preserve a trailing '\r' so CRLF files don't end up with
  // mixed line endings (the untouched lines below keep their '\r').
  const hoisted = importLineIdx.map((i) => lines[i].replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''));
  const remaining = [];
  for (let i = 0; i < lines.length; i++) {
    if (importSet.has(i)) continue;
    remaining.push(lines[i]);
  }
  remaining.splice(insertAt, 0, ...hoisted);
  return { start: 0, end: content.length, text: remaining.join('\n'), diag: diags, wholeFile: true };
}

// Extract {module, name} from a "declares locally but not exported" diagnostic,
// or null. This diagnostic appears on the *importing* file; the fix (adding
// `export`) must land in the module that owns the declaration.
//   Module '"../view/PollListPage"' declares 'PollListPage' locally, but it is not exported.
function extractMissingExport(message) {
  const m = /Module '"([^"]+)"' declares '([^']+)' locally, but it is not exported\./.exec(message || '');
  if (!m) return null;
  return { module: m[1], name: m[2] };
}

// The absolute path from a "File '...' is not a module" diagnostic (TS2306), or
// null. It appears on the importer when the imported file exports nothing at
// all, so the names to export are the ones the importer asks for.
//   File '/p/entry/src/main/ets/components/Card.ets' is not a module.
function extractNotAModule(message) {
  const m = /^File '([^']+)' is not a module\./.exec(message || '');
  return m ? m[1] : null;
}

// The names `importerSource` imports with `import { A, B as C } from '<spec>'`
// from the file `declAbs` (C's original name, A and B). Default and namespace
// imports name nothing that `export` on a declaration would provide.
function namedImportsFrom(importerSource, importerAbs, declAbs) {
  const names = [];
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(importerSource)) !== null) {
    const target = resolveModuleFile(importerAbs, m[2]);
    if (!target || path.resolve(target) !== path.resolve(declAbs)) continue;
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  }
  return names;
}

// Given the source of the module that owns `name`, return an edit that prefixes
// its top-level declaration with `export `, or null if the declaration can't be
// located unambiguously. Handles class/struct/interface/enum/function/const/
// let/var/type and `@Component`-decorated structs (export goes before the
// decorator chain). Never touches a declaration that is already exported.
function buildExportEdit(content, name) {
  const lineStarts = computeLineStarts(content);
  const declRe = new RegExp(
    `^(\\s*)(?:@\\w+(?:\\([^)]*\\))?\\s*)*` +
    `(class|struct|interface|enum|function|const|let|var|type)\\s+${escapeRegExp(name)}\\b`,
  );
  for (let i = 0; i < lineStarts.length; i++) {
    const start = lineStarts[i];
    const end = i + 1 < lineStarts.length ? lineStarts[i + 1] : content.length;
    const line = content.slice(start, end);
    if (!declRe.test(line)) continue;
    // Walk back over a decorator chain (lines like `@Component` / `@Entry`).
    let declLineIdx = i;
    while (declLineIdx > 0 && /^\s*@\w+(?:\([^)]*\))?\s*$/.test(
      content.slice(lineStarts[declLineIdx - 1], lineStarts[declLineIdx]),
    )) declLineIdx--;
    const declStart = lineStarts[declLineIdx];
    if (/^\s*export\b/.test(content.slice(declStart))) return null; // already exported
    // Insert 'export ' right before the declaration keyword on the keyword's line.
    // In ArkTS, `export` must precede the keyword (struct/class/...), not the decorator:
    //   @Component
    //   export struct MyComponent   ← correct
    // not:
    //   export @Component            ← "Declaration or statement expected"
    //   struct MyComponent
    const prefixMatch = line.match(/^\s*(?:@\w+(?:\([^)]*\))?\s*)*/);
    const keywordOffset = prefixMatch ? prefixMatch[0].length : 0;
    const insertAt = start + keywordOffset;
    return { start: insertAt, end: insertAt, text: 'export ', name };
  }
  return null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolve a relative module specifier (from `importerAbs`) to an on-disk .ets
// file. Tries `spec.ets`, `spec/index.ets`, and a bare `spec` that already has
// an extension. Returns an absolute path or null. Only relative specifiers
// (./ or ../) are resolved; bare package imports are left to the compiler.
function resolveModuleFile(importerAbs, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importerAbs), spec);
  const candidates = /\.ets$/.test(base)
    ? [base]
    : [base + '.ets', path.join(base, 'index.ets')];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* not present */ }
  }
  return null;
}

// Build a basename -> [absPath] index over the project's .ets files so the
// relative-import fixer (Tier 1.6) can resolve a broken specifier to a real
// file. Built once per autofix pass and passed in via fixCtx.
function buildModuleIndex(project) {
  const index = new Map();
  for (const abs of collectEtsFiles(project)) {
    const base = path.basename(abs, '.ets');
    if (!index.has(base)) index.set(base, []);
    index.get(base).push(abs);
  }
  return index;
}

// Normalize an absolute target into a relative ESM specifier for `fromDir`:
// forward slashes, no `.ets` extension, `./` prefix when not already `../`.
function toRelativeSpecifier(fromDir, targetAbs) {
  let rel = path.relative(fromDir, targetAbs).replace(/\\/g, '/');
  rel = rel.replace(/\.ets$/, '');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

// Apply edits to content. Edits are applied in descending start order so
// offsets stay valid; overlapping edits are skipped (kept for a later pass).
// Returns { output, applied: [diag...] }.
function applyEdits(content, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start || b.end - a.end);
  let output = content;
  let lastStart = Infinity;
  const applied = [];
  for (const e of sorted) {
    if (e.end > lastStart) continue; // overlaps a later-in-file edit already applied
    output = output.slice(0, e.start) + e.text + output.slice(e.end);
    lastStart = e.start;
    if (Array.isArray(e.diag)) applied.push(...e.diag);
    else applied.push(e.diag);
  }
  return { output, applied };
}

// Stable identity for a diagnostic, used to diff before/after re-check.
function diagKey(d) {
  return `${d.file}|${d.line}|${d.column}|${d.message}`;
}

// Order by file, then position, then rule/message. Plain code-unit comparison
// rather than localeCompare so the result does not depend on the host locale.
function compareStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortDiagnostics(diags) {
  return diags.slice().sort((a, b) =>
    compareStr(String(a.file || ''), String(b.file || '')) ||
    (a.line || 0) - (b.line || 0) ||
    (a.column || 0) - (b.column || 0) ||
    compareStr(String(a.rule || ''), String(b.rule || '')) ||
    compareStr(String(a.message || ''), String(b.message || '')));
}

// --- Checker run (reusable so we can re-check after applying fixes) ---

// hvigor's getResolveModules() returns, per compiled module, four entries:
// [modulePath/src/main, <module>/build/<product>/generated/profile/<target>,
// modulePath/oh_modules, projectTopDir/oh_modules]. The oh_modules pair feeds
// rollup resolution, which the SDK checker does not use (it resolves packages
// itself), so only the first two shapes are reproduced here. What must be
// exact is the generated profile dir: hvigor compiles exactly ONE path per
// module — the selected product's — never a glob over <module>/build/*, so a
// multi-product project must not leak another product's BuildProfile into the
// check, and a nested module (srcPath ./features/sub) must resolve its own.

// Target hvigor compiles for `productName`: the declared target whose
// applyToProducts includes the product; otherwise 'default' (hvigor's own
// fallback — DefaultTargetConst.DEFAULT_TARGET).
function pickTargetNameForProduct(targets, productName) {
  if (Array.isArray(targets)) {
    for (const t of targets) {
      if (t && Array.isArray(t.applyToProducts) && t.applyToProducts.includes(productName) &&
        typeof t.name === 'string' && t.name) {
        return t.name;
      }
    }
  }
  return 'default';
}

// modules[].srcPath from build-profile.json5 is the authoritative module list
// hvigor compiles. Filesystem walks miss nested modules and pick up unrelated
// dirs; the declared list does neither. The product choice mirrors
// readProjectSdkConfig so the check compiles against the same product the SDK
// config was resolved from.
function readProjectModules(projectPath) {
  let parsed = null;
  try {
    parsed = parseJson5Loose(fs.readFileSync(path.join(projectPath, 'build-profile.json5'), 'utf-8'));
  } catch { /* missing/unparseable profile: no declared modules */ }
  const products = parsed && parsed.app && Array.isArray(parsed.app.products) ? parsed.app.products : [];
  const product = products.find((p) => p && p.name === 'default') || products[0] || null;
  const productName = product && typeof product.name === 'string' && product.name ? product.name : 'default';
  const rawModules = parsed && Array.isArray(parsed.modules) ? parsed.modules : [];
  const modules = [];
  for (const m of rawModules) {
    if (!m || typeof m.name !== 'string' || !m.name) continue;
    const srcPath = typeof m.srcPath === 'string' && m.srcPath ? m.srcPath : './' + m.name;
    modules.push({ name: m.name, srcPath, target: pickTargetNameForProduct(m.targets, productName) });
  }
  return { productName, modules };
}

// Exported for tests: the remediation hint when BuildProfile cannot resolve
// because nothing has been built yet (issue #614), or null when build output
// exists (an unresolved BuildProfile then means something else).
function buildProfileNotBuiltHint(projectPath) {
  const { productName, modules } = readProjectModules(projectPath);
  if (modules.length === 0) return null;
  const built = modules.some((m) =>
    fs.existsSync(path.resolve(projectPath, m.srcPath, 'build', productName, 'generated', 'profile')));
  if (built) return null;
  return `No module has build output for product '${productName}' yet, so generated modules such as BuildProfile do not exist. ` +
    `Run a build first (oniro-app build), then re-run the check.`;
}

const resolveModulePathsCache = new Map();

function collectResolveModulePaths(projectPath) {
  const cached = resolveModulePathsCache.get(projectPath);
  if (cached) return cached;

  const roots = [];
  const seen = new Set();
  const push = (p) => {
    try {
      const r = path.resolve(p);
      if (!seen.has(r) && fs.existsSync(r)) {
        seen.add(r);
        roots.push(r);
      }
    } catch { /* ignore */ }
  };

  const { productName, modules } = readProjectModules(projectPath);
  if (modules.length > 0) {
    for (const m of modules) {
      const modulePath = path.resolve(projectPath, m.srcPath);
      push(path.join(modulePath, 'src', 'main'));
      // Exactly hvigor's buildGeneratedProfilePath shape. A missing dir (module
      // not built for this product yet) is simply not added — runCheck then
      // attaches buildProfileNotBuiltHint to the resulting diagnostic.
      push(path.join(modulePath, 'build', productName, 'generated', 'profile', m.target));
    }
  } else {
    // No declared modules (minimal or unparseable profile): fall back to
    // discovering modules on disk so a plain layout still resolves.
    findModuleSrcMainOnDisk(projectPath, push);
  }

  resolveModulePathsCache.set(projectPath, roots);
  return roots;
}

// Legacy fallback for collectResolveModulePaths when build-profile.json5
// declares no modules: walk the tree for src/main dirs and generated profile
// dirs. Nested-module discovery needs the depth recursion; declared-srcPath
// mode does not.
function findModuleSrcMainOnDisk(projectPath, push) {
  function findModuleSrcMain(dir, depth) {
    if (depth > 3 || !fs.existsSync(dir)) return;
    const srcMain = path.join(dir, 'src', 'main');
    if (fs.existsSync(srcMain)) push(srcMain);
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.isDirectory() && !['node_modules', 'oh_modules', 'build', '.git', '.hvigor', '.cache'].includes(it.name)) {
        findModuleSrcMain(path.join(dir, it.name), depth + 1);
      }
    }
  }
  findModuleSrcMain(projectPath, 0);

  function walkBuildGenerated(dir) {
    if (!fs.existsSync(dir)) return;
    let moduleDirs;
    try { moduleDirs = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const mod of moduleDirs) {
      if (!mod.isDirectory()) continue;
      const buildDir = path.join(dir, mod.name, 'build');
      if (!fs.existsSync(buildDir)) continue;
      let buildEntries;
      try { buildEntries = fs.readdirSync(buildDir, { withFileTypes: true }); } catch { continue; }
      for (const b of buildEntries) {
        if (!b.isDirectory()) continue;
        const profileDir = path.join(buildDir, b.name, 'generated', 'profile');
        if (!fs.existsSync(profileDir)) continue;
        let targets;
        try { targets = fs.readdirSync(profileDir, { withFileTypes: true }); } catch { continue; }
        for (const t of targets) {
          if (t.isDirectory()) push(path.join(profileDir, t.name));
        }
      }
    }
  }
  walkBuildGenerated(projectPath);
}

// Project-level diagnostics read only immutable config/SDK files (module.json5,
// main_pages.json, hvigor-config.json5, PermissionDefinitions.json, string.json,
// resources/*/{media,profile,element}) plus a scan of `files` and — for the
// cross-file @ObservedV2 index — every other project .ets. main() computes them
// ONCE and carries them on env; runChecker just re-injects the array instead of
// re-reading and re-parsing the SDK's (large) PermissionDefinitions.json on
// every pass.
//
// Most fix tiers cannot invalidate this: they rewrite import specifiers, export
// keywords and type annotations, never config/resource files, `$r('app.*')`
// references, or an @ObservedV2 class declaration. The component-version fix
// (Tier 1.5) IS an exception — it rewrites the very @Component/@ComponentV2
// decorator these checks read — so applyAutoFixes recomputes this after applying
// edits rather than trusting the cache.
function computeProjectDiagnostics(files, env, hasExplicitFiles) {
  const { sdkDir, projectPath } = env;
  const fileScoped = [
    ...validateSystemResources(files, sdkDir, projectPath),
    ...validateAppResources(files, projectPath),
    ...validateComponentDecorators(files, projectPath),
    ...validateObservedV2PropertyTypes(files, projectPath),
    ...validateRegularPropertyInit(files, projectPath),
    ...validateStructNameCollisions(files, projectPath),
    ...validateEntryBuildRootNode(files, projectPath),
    ...validateBuilderBodyStatements(files, projectPath),
    ...validateV2MemberDecoratorRules(files, projectPath),
    ...validateNavDestinationRegistration(files, projectPath),
    ...validateHideNavBarUsage(files, projectPath),
    ...validateNavDestinationRoot(files, projectPath),
    ...validateAppStorageV2Mixing(files, projectPath),
  ];
  // 项目级校验器（不依赖 files 参数）仅在检查整个项目时运行，
  // 指定具体文件时跳过，避免因被检查文件不在列表中而误报。
  if (hasExplicitFiles) return fileScoped;
  return [
    ...fileScoped,
    ...validateRouterPages(projectPath),
    ...validateRouteMapProfile(projectPath),
    ...validateResourceDirNames(projectPath),
    ...validateModelVersion(projectPath),
    ...validatePermissions(projectPath, sdkDir),
  ];
}

// Runs etsStandaloneChecker over `files` and returns the filtered diagnostics
// (relative paths, binding/FA false positives removed). `env` carries the
// resolved paths so we don't re-detect the SDK on every call.
function cleanupCheckerCache(projectPath) {
  const cachePath = path.join(projectPath, '.cache', 'arkts-check');
  try { fs.rmSync(cachePath, { recursive: true, force: true }); } catch { /* best-effort */ }
  // `.cache` 可能被其它工具使用，仅在为空时移除。
  try {
    const parent = path.dirname(cachePath);
    if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch { /* best-effort */ }
}

function runChecker(files, env) {
  const { sdkDir, etsLoaderPath, projectPath, aceModuleJsonPath } = env;
  // Carried on env when runCheck computed it (one profile read per request);
  // read here so runChecker stays usable standalone, as in tests.
  const sdkConfig = env.sdkConfig || readProjectSdkConfig(projectPath, env.sdkDir);

  const fileMap = {};
  files.forEach((f, i) => { fileMap[`file_${i}`] = f; });

  const captured = [];
  let checkerFailure;
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const capture = (...a) => { captured.push(a.map(String).join(' ')); };
  console.log = capture;
  console.error = capture;
  console.warn = capture;

  const hmsSdkEts = env.hmsEtsDir || '';
  if (hmsSdkEts && fs.existsSync(hmsSdkEts) && !(process.env.externalApiPaths || '').includes(hmsSdkEts)) {
    const existing = process.env.externalApiPaths || '';
    process.env.externalApiPaths = existing ? existing + path.delimiter + hmsSdkEts : hmsSdkEts;
  }

  try {
    const etsChecker = require(path.join(etsLoaderPath, 'lib', 'ets_checker.js'));
    const mainModule = require(path.join(etsLoaderPath, 'main.js'));

    Object.assign(mainModule.partialUpdateConfig, {
      executeArkTSLinter: true,
      standardArkTSLinter: true,
    });

    // SDK 6.1.1+ added an API whitelist validator that reads
    // `main.projectConfig.globalModulePaths` (api/, arkts/, kits/) and calls
    // `.some` on it unguarded. In a full build, init_config.js copies it there
    // from the module-level `main.globalModulePaths` that main.js populates on
    // load; the standalone checker never runs init_config, so the field is
    // undefined and every check dies with "Cannot read properties of undefined".
    // Bridge the two here. Older SDKs lack the validator entirely and ignore it.
    if (Array.isArray(mainModule.globalModulePaths) && !mainModule.projectConfig.globalModulePaths) {
      mainModule.projectConfig.globalModulePaths = mainModule.globalModulePaths;
    }

    // The checker's `checkSinceValue` and `checkFileHasAvailableByFileName`
    // (local functions in api_check_utils.js) gate the @since version
    // comparison on `sourceFilePath.startsWith(projectRootPath)`. SDK .d.ts
    // files live under the SDK ets directory, so projectRootPath must point
    // there for the path check to pass and the version comparison to run.
    // Set it directly on the module's projectConfig — NOT in the projectConfig
    // object below — so `Object.assign` in `initEtsStandaloneCheckerConfig`
    // does not overwrite it.
    mainModule.projectConfig.projectRootPath = path.join(sdkDir, 'ets');

    // Standalone checker must mirror the rollup ets-checker path: only
    // with compileTool='rollup' does setCompilerOptions map
    // resolveModulePaths into compilerOptions.paths ...
    process.env.compileTool = 'rollup';
    process.env.compileMode = 'moduleJson';

    const projectConfig = {
      projectPath,
      modulePath: projectPath,
      cachePath: path.join(projectPath, '.cache', 'arkts-check'),
      aceModuleJsonPath,
      compileMode: 'esmodule',
      etsLoaderPath,
      packageManagerType: 'ohpm',
      packageDir: 'oh_modules',
      // From the project's build-profile.json5, not assumed: checking against a
      // different API surface than the build compiles against is how a check
      // passes on a member the build then rejects.
      runtimeOS: sdkConfig.runtimeOS,
      sdkInfo: sdkConfig.sdkInfo,
      compatibleSdkVersion: sdkConfig.compatibleSdkVersion,
      // SinceJSDocChecker reads originCompatibleSdkVersion first, falling back
      // to compatibleSdkVersion. partialUpdateController sets minAPIVersion.
      // Set all three to the same resolved API level so every code path in the
      // checker sees a consistent version.
      compileSdkVersion: sdkConfig.compatibleSdkVersion,
      minAPIVersion: sdkConfig.compatibleSdkVersion,
      originCompatibleSdkVersion: sdkConfig.compatibleSdkVersion,
      bundleType: '',
      compilerTypes: [],
      resolveModulePaths: collectResolveModulePaths(projectPath),
    };

    // The checker persists .tsbuildinfo/.tsbuildinfo.linter under cachePath.
    // Stale cache from a prior run with different parameters causes the
    // checker to reuse old diagnostics — the @since version checks silently
    // never re-run. Delete the cache directory before each run.
    try { fs.rmSync(projectConfig.cachePath, { recursive: true, force: true }); } catch { /* best-effort */ }
    fs.mkdirSync(projectConfig.cachePath, { recursive: true });

    const logger = { debug: capture, info: capture, warn: capture, error: capture };
    etsChecker.etsStandaloneChecker(fileMap, logger, projectConfig);
  } catch (e) {
    // The checker threw, so it type-checked nothing (or stopped partway) and the
    // diagnostics below describe an incomplete run. Recording this in `captured`
    // is not enough: the parse loop only keeps lines matching `ArkTS:ERROR File:
    // path:line:col`, so this line is dropped and the run reports as clean --
    // a crash and a genuinely error-free project become indistinguishable.
    // Rethrow instead. In the daemon, handleRequest turns it into an `error`
    // result the tool surfaces; as a one-shot CLI it exits non-zero with the
    // message on stderr, which runOneShot raises. Both are loud.
    checkerFailure = e;
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    // 缓存只在单次检查期间有效（下次运行前会重建），结束后清掉，
    // 避免在用户工程根残留 .cache/arkts-check 目录。
    cleanupCheckerCache(projectPath);
  }

  // Thrown after console is restored so the message is not swallowed by capture.
  if (checkerFailure) {
    // The stack, not just the message: the failures worth diagnosing here come
    // from inside the SDK's own loader reading a projectConfig field this script
    // does not supply, and a bare "Cannot read properties of undefined" names
    // neither the field nor the loader module. The top frames do.
    const detail = checkerFailure.stack || checkerFailure.message;
    throw new Error(
      `arkts_check could not complete: the ArkTS checker failed over ${files.length} file(s). ` +
      `No type-check result is available, so this is NOT a clean result. ` +
      `Underlying error: ${detail}`,
    );
  }

  const diagnostics = [];
  let current = null;
  const lines = captured.flatMap(entry => entry.split('\n'));

  for (const line of lines) {
    const clean = line.replace(/\x1b\[\d+m/g, '').replace(/\[(\d+)m/g, '');
    const loc = parseDiagnosticLine(clean);
    if (loc) { current = loc; continue; }
    if (current && clean.trim() && !clean.includes('ArkTS:') && !clean.includes('For details about')) {
      const { message, rule } = parseMessageLine(clean);
      diagnostics.push({
        file: path.relative(projectPath, current.file),
        line: current.line,
        column: current.column,
        severity: current.severity === 'error' ? 'error' : 'warning',
        message,
        rule,
      });
      current = null;
    }
  }

  // Reuse the project-level diagnostics computed once in main(); fall back to
  // computing them here so runChecker stays usable standalone (e.g. in tests).
  const projectDiagnostics = env.skipProjectDiagnostics
    ? []
    : (env.projectDiagnostics || computeProjectDiagnostics(files, env, env.hasExplicitFiles));
  diagnostics.push(...projectDiagnostics);

  return dropFalsePositives(diagnostics, projectPath, aceModuleJsonPath);
}

// The checker type-checks the whole program, so SDK `.d.ets` files are pulled in
// transitively. Its parser does not understand the SDK's own ArkTS annotation
// syntax (`@interface Retention` in @arkts.lang.d.ets), so it reports parse
// errors against SDK sources that the real hvigor build never reports. Neither
// user code nor fixable, so drop them.
function isOutsideProject(relPath) {
  // Across drive letters (project on E:, SDK on C:) path.relative returns an
  // absolute path instead of a `..` prefix, so both checks are needed.
  return relPath.startsWith('..') || path.isAbsolute(relPath);
}

// Declaration files are never AI-authored source, so their diagnostics are not
// actionable even when they sit inside the project (e.g. under oh_modules).
function isDeclarationFile(relPath) {
  return relPath.endsWith('.d.ets') || relPath.endsWith('.d.ts');
}

// Out-of-project and declaration-file noise, FA-mode noise on a Stage project,
// and ArkUI `$`/`$$` binding sugar the checker reads as unknown identifiers.
// Shared so the cached path filters identically.
function dropFalsePositives(diagnostics, projectPath, aceModuleJsonPath) {
  const isStageProject = aceModuleJsonPath !== '';
  return diagnostics.filter(d => {
    if (isOutsideProject(d.file)) return false;
    if (isDeclarationFile(d.file)) return false;
    if (isStageProject && d.message.includes('the current Mode is FA')) return false;
    if (isBindingSyntaxFalsePositive(d, projectPath)) return false;
    return true;
  });
}

// Checker diagnostics for `files`, reusing cached results for files whose
// dependency closure is unchanged and running the checker only over the rest.
// Project-level diagnostics are excluded — they are computed once per request in
// runCheck and are not per-file, so they must not enter the per-file cache.
//
// Worth roughly 25ms per skipped file. That is small next to the ~2s fixed cost
// of a warm check, but it is what makes re-sending an unchanged 47-file list
// cheap, which is the pattern the prompt asks the model to follow.
function cachedCheckerDiagnostics(files, env) {
  const epoch = computeEpoch(env.projectPath, env.sdkDir);
  if (epoch !== cacheEpoch) {
    fileDiagCache.clear();
    cacheEpoch = epoch;
  }

  const hashes = new Map(files.map((f) => [f, closureHash(f)]));
  const stale = files.filter((f) => fileDiagCache.get(f)?.closureHash !== hashes.get(f));

  if (stale.length > 0) {
    const fresh = runChecker(stale, { ...env, skipProjectDiagnostics: true });
    // Seed an empty entry for every re-checked file so a clean file is a future
    // hit rather than a permanent miss.
    for (const f of stale) fileDiagCache.set(f, { closureHash: hashes.get(f), diagnostics: [] });
    for (const d of fresh) {
      const abs = path.isAbsolute(d.file) ? d.file : path.resolve(env.projectPath, d.file);
      // The checker can attribute a diagnostic to a file outside `stale` (for
      // example a dependency); those are kept in the result but not cached, since
      // this pass did not check that file in full.
      const entry = fileDiagCache.get(abs);
      if (entry && entry.closureHash === hashes.get(abs)) entry.diagnostics.push(d);
    }
    return [...fresh, ...files.filter((f) => !stale.includes(f)).flatMap((f) => fileDiagCache.get(f).diagnostics)];
  }

  return files.flatMap((f) => fileDiagCache.get(f).diagnostics);
}

// Drop cache entries for files the auto-fixer rewrote. Their closure hash has
// changed anyway, so this is belt-and-braces against a hash collision or a
// same-content rewrite, and keeps the cache from growing stale entries.
function invalidateFileDiagCache(absPaths) {
  for (const abs of absPaths) fileDiagCache.delete(abs);
}

// Merge a partial (incremental) re-check back into a whole-project view.
// `recheckResult` holds the accurate diagnostics for the files in `recheckSet`
// (absolute paths); every other file keeps its `firstPass` diagnostics. Project
// diagnostics (identity-compared against `projectDiags`) already live in
// `recheckResult`, so they are dropped from the carried-over first-pass entries
// to avoid duplication. `absOf` maps a diagnostic's (relative) file to absolute.
function mergeIncrementalDiagnostics(firstPass, recheckResult, recheckSet, projectDiags, absOf) {
  const projectSet = new Set(projectDiags);
  const carriedOver = firstPass.filter((d) => !projectSet.has(d) && !recheckSet.has(absOf(d.file)));
  return [...recheckResult, ...carriedOver];
}

// Produce the accurate diagnostics for the re-checked subset AFTER a regression
// revert, without another checker run: reverted files return to their first-pass
// diagnostics, kept files keep their `after` diagnostics, and project diagnostics
// appear exactly once. Only valid when no reverted file is a cross-file
// propagation source (an export-fix decl file) — the caller checks that first.
// `staleProjectDiags` are first-pass project diagnostic objects superseded by a
// recompute; they are filtered out like `projectDiags` but not re-emitted.
function spliceRevertedDiagnostics(firstPass, after, reverted, projectDiags, absOf, staleProjectDiags = []) {
  const projectSet = new Set([...projectDiags, ...staleProjectDiags]);
  const kept = after.filter((d) => !projectSet.has(d) && !reverted.has(absOf(d.file)));
  const restored = firstPass.filter((d) => !projectSet.has(d) && reverted.has(absOf(d.file)));
  return [...kept, ...restored, ...projectDiags];
}

// Restore first-pass diagnostics that the re-check pass silently dropped.
//
// applyAutoFixes seeds recheckSet with every originally-checked file (so an
// indirectly-fixed importer cannot carry a stale error), which means
// mergeIncrementalDiagnostics carries nothing over and the re-check becomes the
// sole source of truth for the whole project. That is only sound if the
// re-check reproduces everything the first pass found -- and a checker run is
// not guaranteed to, so a diagnostic can vanish with no fix behind it. The
// regression guard does not catch this: it only fires when a file's error count
// goes UP, and a vanished error makes the count go DOWN, which reads as success.
//
// A file the fixer never wrote cannot have been fixed, so any of its first-pass
// diagnostics missing from the merged view is under-reporting and comes back.
// Files the fixer did write are left alone: one edit legitimately clears
// diagnostics it was not aimed at (fixing an import path resolves every
// `Cannot find name` that depended on it), so restoring those would report
// errors the source no longer has. Reverted files count as untouched -- their
// content is back to the original, so their original diagnostics still hold.
function restoreDroppedDiagnostics(firstPass, merged, writtenFiles, absOf) {
  const present = new Set(merged.map(diagKey));
  const dropped = firstPass.filter((d) => !present.has(diagKey(d)) && !writtenFiles.has(absOf(d.file)));
  return dropped.length > 0 ? [...merged, ...dropped] : merged;
}

// Put every fixer edit back. Used when the verification re-check throws: the
// edits are already on disk but nothing has confirmed them, and leaving them
// there would hand back a rewritten tree with no diagnostics to judge it by.
// Files whose `original` has been released were already verified and kept, so
// they are skipped; re-reverting an already-reverted file is a no-op.
function revertAllTouched(touched) {
  for (const t of touched) {
    if (t.original === null || t.original === undefined) continue;
    try {
      fs.writeFileSync(t.abs, t.original, 'utf-8');
    } catch {
      // Best effort: a file we cannot restore is worse than one we can, but
      // failing the whole revert over it would strand the rest.
    }
  }
}

// Attempt heuristic fixes over `diagnostics`. Edits are applied per file, then
// only the affected files (edited files + the importers of any cross-file
// `export` fix) are re-checked — untouched files keep their first-pass results.
// A diagnostic is reported fixed only if it disappeared AND the file's error
// count did not rise; otherwise the file is reverted. Returns
// { fixed: [...], diagnostics: [...] } (post-fix, whole-project diagnostics).
function applyAutoFixes(diagnostics, env) {
  const { projectPath } = env;
  const absOf = (rel) => path.isAbsolute(rel) ? rel : path.resolve(projectPath, rel);

  // Group fixable diagnostics by absolute file path.
  const byFile = new Map();
  for (const d of diagnostics) {
    if (d.severity !== 'error') continue;
    const abs = absOf(d.file);
    if (!byFile.has(abs)) byFile.set(abs, []);
    byFile.get(abs).push(d);
  }

  // Basename index for the Tier 1.6 relative-import fixer. Built once and reused
  // for every file; only used when a "Cannot find module" diagnostic appears.
  const moduleIndex = buildModuleIndex(projectPath);

  const touched = [];       // { abs, original, appliedKeys:Set }
  for (const [abs, diags] of byFile) {
    let content;
    try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
    const edits = buildFileEdits(content, diags, { abs, index: moduleIndex, project: projectPath });
    if (edits.length === 0) continue;
    const { output, applied } = applyEdits(content, edits);
    if (output === content || applied.length === 0) continue;
    fs.writeFileSync(abs, output, 'utf-8');
    touched.push({ abs, original: content, appliedKeys: new Set(applied.map(diagKey)) });
  }

  // Cross-file channel: "declares 'X' locally, but it is not exported" appears on
  // the importing file, but the fix lands in the module that owns the decl. Group
  // by declaring file so one file gets a single edit even if imported many times.
  const exportByDecl = new Map(); // declAbs -> { edits:[{name}], keys:Set<diagKey> }
  const exportImporters = new Set(); // importer abs paths that reported a missing export
  for (const d of diagnostics) {
    if (d.severity !== 'error') continue;
    const importerAbs = absOf(d.file);
    let declAbs = null;
    let names = [];
    const info = extractMissingExport(d.message);
    if (info) {
      declAbs = resolveModuleFile(importerAbs, info.module);
      names = [info.name];
    } else {
      const notModule = extractNotAModule(d.message);
      if (!notModule) continue;
      declAbs = path.isAbsolute(notModule) ? notModule : path.resolve(projectPath, notModule);
      try {
        names = namedImportsFrom(fs.readFileSync(importerAbs, 'utf-8'), importerAbs, declAbs);
      } catch { continue; }
      if (names.length === 0) continue;
    }
    // Skip if unresolved, already edited, or the decl file resolves OUTSIDE the
    // project root — never write beyond the project we were asked to check.
    if (!declAbs || (touched && touched.some(t => t.abs === declAbs))) continue;
    const projRoot = path.resolve(projectPath);
    const declResolved = path.resolve(declAbs);
    if (declResolved !== projRoot && !declResolved.startsWith(projRoot + path.sep)) continue;
    exportImporters.add(importerAbs);
    if (!exportByDecl.has(declAbs)) exportByDecl.set(declAbs, { names: new Map(), keys: new Set() });
    const bucket = exportByDecl.get(declAbs);
    for (const name of names) bucket.names.set(name, true);
    bucket.keys.add(diagKey(d));
  }
  const exportDeclAbs = new Set(); // decl files edited by the export fix (cross-file propagation sources)
  for (const [declAbs, bucket] of exportByDecl) {
    let content;
    try { content = fs.readFileSync(declAbs, 'utf-8'); } catch { continue; }
    const edits = [];
    for (const name of bucket.names.keys()) {
      const e = buildExportEdit(content, name);
      if (e) edits.push(e);
    }
    if (edits.length === 0) continue;
    const { output } = applyEdits(content, edits);
    if (output === content) continue;
    fs.writeFileSync(declAbs, output, 'utf-8');
    touched.push({ abs: declAbs, original: content, appliedKeys: bucket.keys });
    exportDeclAbs.add(declAbs);
  }

  if (!touched || touched.length === 0) return { fixed: [], diagnostics };

  // The auto-fixer rewrote these files, so any cached diagnostics for them (and
  // for importers whose missing-export error it targeted) describe the old text.
  // Their closure hashes have changed too, but dropping the entries keeps the
  // cache from carrying results this pass is about to supersede.
  invalidateFileDiagCache([...(touched || []).map((t) => t.abs), ...exportImporters]);

  // Incremental re-check: a fix only changes diagnostics in the file it edited,
  // plus — for the cross-file `export` fix — the importer files that referenced
  // the symbol (their "not exported" error must be re-evaluated). Re-checking
  // that subset is enough to verify the fixes and detect regressions; every
  // other file keeps its first-pass diagnostics. This relies on a file's
  // diagnostics depending only on its own content plus its on-disk dependencies,
  // not on whether sibling files are in the checker's file set.
  //
  // Seed with ALL originally-checked files so mergeIncrementalDiagnostics never
  // carries over a stale error from a file that was indirectly fixed (e.g. a
  // missing-export error in an untouched importer whose symbol now exists).
  const recheckSet = new Set(env.files || []);
  for (const t of touched) recheckSet.add(t.abs);
  for (const imp of exportImporters) recheckSet.add(imp);
  const recheckFiles = [...recheckSet];

  for (const t of touched) stateFieldCache.delete(t.abs);

  // The component-version fix (Tier 1.5) rewrites a struct's @Component /
  // @ComponentV2 decorator, which is exactly the input to the source-derived
  // project-level checks (component-decorator-version-mismatch and the
  // @ObservedV2 property-type rule). So unlike every earlier fix tier, these
  // cached diagnostics CAN go stale after an edit: recompute them before the
  // re-check, or a successful flip still reports its original mismatch and the
  // fix is never credited.
  // `diagnostics` still holds the first-pass project diagnostic objects. The merge
  // and splice below drop project entries by identity, so they need both the old
  // and the recomputed objects; with only the new ones, every first-pass project
  // diagnostic on a non-.ets file (module.json5, route_map.json, resource dirs)
  // survives as "carried over" and is reported twice.
  const firstPassProjectDiags = env.projectDiagnostics || [];
  if (touched && touched.length > 0) {
    env.projectDiagnostics = computeProjectDiagnostics(env.files || [], env, env.hasExplicitFiles);
  }

  // The ets checker persists incremental build info (.tsbuildinfo) under
  // `.cache/arkts-check`. After auto-fix rewrites a file on disk, the cached
  // build info still describes the pre-edit module graph — so the recheck
  // would read stale module resolution and re-report the original error
  // (e.g. "declares 'X' locally, but it is not exported" persists even after
  // `export` was added). Delete the cache directory so the checker rebuilds
  // from the current file contents.
  const cacheDir = path.join(projectPath, '.cache', 'arkts-check');
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* best-effort */ }

  // The ets checker and its TypeScript compiler dependency hold in-memory
  // module resolution state from the first pass. Clearing the require cache
  // for all non-built-in modules forces a fresh load so the recheck reads
  // the edited files rather than the cached module graph.
  for (const modPath of Object.keys(require.cache)) {
    if (!modPath.includes('\\node\\') && !modPath.startsWith('node:')) {
      delete require.cache[modPath];
    }
  }

  // runChecker throws when the ArkTS checker fails. The edits are on disk by
  // now, so roll them back before the error propagates -- an unverified rewrite
  // is not something to leave behind on a failed check.
  let after;
  try {
    after = runChecker(recheckFiles, env);
  } catch (e) {
    revertAllTouched(touched);
    throw new Error(`${e.message} (auto-fix edits were rolled back)`);
  }

  const projectDiags = env.projectDiagnostics || [];
  const allProjectDiags = [...firstPassProjectDiags, ...projectDiags];
  // Per-file error counts before/after to detect regressions.
  const errCount = (list, abs) => list.filter(d => d.severity === 'error' && absOf(d.file) === abs).length;

  const reverted = new Set();
  for (const t of touched) {
    if (errCount(after, t.abs) > errCount(diagnostics, t.abs)) {
      fs.writeFileSync(t.abs, t.original, 'utf-8');
      reverted.add(t.abs);
    }
  }

  // `original` is only needed for the revert above; drop the kept files' copies
  // so we don't hold every touched file's full source through the rest of the pass.
  for (const t of touched) {
    if (!reverted.has(t.abs)) t.original = null;
  }

  // Accurate diagnostics for the re-checked subset after any reverts.
  let recheckResult;
  if (reverted.size === 0) {
    recheckResult = after;
  } else if ([...reverted].some(abs => exportDeclAbs.has(abs))) {
    // A reverted export fix re-breaks its importers, which `after` still shows as
    // fixed; splicing would be wrong, so re-run the (still incremental) checker.
    for (const t of (touched || [])) stateFieldCache.delete(t.abs);
    try {
      recheckResult = runChecker(recheckFiles, env);
    } catch (e) {
      // Kept files released their `original` above, so only the already-reverted
      // ones are restorable here. That is the right scope anyway: the first
      // re-check confirmed each kept edit did not regress its own file, so those
      // stay. Only the verdict on the reverted files' importers is missing.
      revertAllTouched(touched);
      throw new Error(`${e.message} (reverted-file edits were rolled back; kept edits remain)`);
    }
  } else {
    // No cross-file propagation among reverted files: splice instead of re-running.
    recheckResult = spliceRevertedDiagnostics(diagnostics, after, reverted, projectDiags, absOf, firstPassProjectDiags);
  }

  // Only files still holding a fixer edit may lose diagnostics; a reverted file
  // is back to its original content, so it is treated as untouched.
  // Importers targeted by the cross-file `export` fix are also included: their
  // "not exported" error was cleared indirectly by the edit to the declaring
  // module, even though the importer file itself was never written.
  const writtenFiles = new Set([
    ...(touched || []).filter((t) => !reverted.has(t.abs)).map((t) => t.abs),
    ...exportImporters,
  ]);
  const merged = mergeIncrementalDiagnostics(diagnostics, recheckResult, recheckSet, allProjectDiags, absOf);
  const finalDiagnostics = restoreDroppedDiagnostics(diagnostics, merged, writtenFiles, absOf);

  // Built from the guarded view: a restored diagnostic must not read as fixed.
  const finalKeys = new Set(finalDiagnostics.map(diagKey));

  const fixed = [];
  for (const t of (touched || [])) {
    if (reverted.has(t.abs)) continue;
    for (const d of diagnostics) {
      if (t.appliedKeys.has(diagKey(d)) && !finalKeys.has(diagKey(d))) fixed.push(d);
    }
  }

  // Files we edited (and kept) that were NOT in the caller's original file list
  // — these come from the cross-file `export` fix landing in a declaring module.
  // Surface them so the caller knows the diff includes files it didn't ask to check.
  const requested = new Set(env.files || []);
  const alsoModified = (touched || [])
    .filter(t => !reverted.has(t.abs) && !requested.has(t.abs))
    .map(t => path.relative(projectPath, t.abs));

  return { fixed, diagnostics: finalDiagnostics, alsoModified };
}

// One check pass over `args` ({ project, files, fix }). Returns the result object
// the CLI serializes to stdout; never calls process.exit, so `--serve` can reuse
// it request after request in one warm process.
function runCheck(args) {
  if (!args.project) {
    return { success: false, error: 'Missing --project argument', errors: [], summary: { errorCount: 0, warnCount: 0 } };
  }

  if (!fs.existsSync(args.project)) {
    return { success: false, error: `Project path not found: ${args.project}`, errors: [], summary: { errorCount: 0, warnCount: 0 } };
  }

  // --project 必须是目录，不是文件
  const projStat = fs.statSync(args.project);
  if (projStat.isFile()) {
    return {
      success: false,
      error: `--project must be a project root directory, not a file: ${args.project}`,
      errors: [],
      summary: { errorCount: 0, warnCount: 0 },
    };
  }

  const { sdkDir, hmsEtsDir } = resolveSdk(args);
  if (!sdkDir) {
    return { success: false, error: 'No SDK given. Pass --sdk <dir> (an OpenHarmony SDK API directory such as <sdk-root>/20, or DevEco\'s sdk/default/openharmony), or set DEVECO_HOME.', errors: [], summary: { errorCount: 0, warnCount: 0 } };
  }

  const etsLoaderPath = findEtsLoader(sdkDir);
  if (!etsLoaderPath) {
    return { success: false, error: `Cannot find ets/build-tools/ets-loader/lib/ets_checker.js in the SDK at: ${sdkDir}`, errors: [], summary: { errorCount: 0, warnCount: 0 } };
  }
  let files = args.files.map(f => path.isAbsolute(f) ? f : path.resolve(args.project, f));
  // Filter out directories and non-.ets files from the explicit file list.
  // When the CLI passes `.` (cwd) as a positional arg, it resolves to a
  // directory path that would crash fs.readFileSync in validateSystemResources.
  if (files.length > 0) {
    files = files.filter(f => fs.existsSync(f) && fs.statSync(f).isFile() && f.endsWith('.ets') && !f.endsWith('.d.ets'));
  }
  // 用户是否显式指定了有效的 .ets 文件（用于跳过项目级校验器）
  const hasExplicitFiles = files.length > 0;
  if (files.length === 0) {
    // 全模块收集：entry-only 版本在多模块工程（products/features/commons 等，
    // 无 entry 模块）下返回空集，导致静默 0 文件空跑。
    files = collectProjectEtsFiles(args.project);
  }

  if (files.length === 0) {
    return { success: true, errors: [], summary: { errorCount: 0, warnCount: 0 } };
  }

  const moduleJsonCandidates = [
    path.join(args.project, 'entry', 'src', 'main', 'module.json5'),
    path.join(args.project, 'src', 'main', 'module.json5'),
    path.join(args.project, 'entry', 'module.json5'),
  ];
  let aceModuleJsonPath = '';
  for (const candidate of moduleJsonCandidates) {
    if (fs.existsSync(candidate)) {
      aceModuleJsonPath = candidate;
      break;
    }
  }

  // Read once per request rather than per runChecker call: auto-fix never edits
  // build-profile.json5, so its SDK values cannot change mid-request.
  const sdkConfig = readProjectSdkConfig(args.project, sdkDir);

  const env = { sdkDir, hmsEtsDir, etsLoaderPath, projectPath: args.project, aceModuleJsonPath, files, sdkConfig, hasExplicitFiles };

  // Compute project-level diagnostics once and carry them on env: auto-fix never
  // edits the config files they read, so the (potentially large) SDK JSON reads
  // and JSON.parse are done a single time regardless of how many re-checks run.
  env.projectDiagnostics = computeProjectDiagnostics(files, env, hasExplicitFiles);

  // The per-file cache only pays off across requests, so it is limited to the
  // warm --serve process; a one-shot CLI run would just hash files for nothing.
  const checkerDiags = args.cache ? cachedCheckerDiagnostics(files, env) : undefined;
  let filtered = checkerDiags
    ? [...checkerDiags, ...dropFalsePositives(env.projectDiagnostics, args.project, aceModuleJsonPath)]
    : runChecker(files, env);
  // How many of these came from the ArkTS checker rather than the source-derived
  // project rules. The two layers fail independently: across an observed 26-task
  // run, several sessions produced project-rule diagnostics normally while the
  // checker returned nothing at all, and their builds then failed on the type
  // errors it should have caught. The count is what makes that distinguishable
  // from a project that is genuinely clean, so it is reported, not inferred.
  const projectDiagSet = new Set(env.projectDiagnostics);
  let checkerDiagCount = filtered.filter((d) => !projectDiagSet.has(d)).length;
  let fixed = [];
  let alsoModified = [];

  if (args.fix && filtered.some(d => d.severity === 'error')) {
    const res = applyAutoFixes(filtered, env);
    fixed = res.fixed;
    filtered = res.diagnostics;
    alsoModified = res.alsoModified || [];
    // applyAutoFixes may recompute env.projectDiagnostics into a fresh array, so
    // the identity set above no longer matches; rebuild before recounting.
    //
    // Keep the higher of the two counts. The question this feeds is whether the
    // checker produced anything at all, not how much is still unfixed -- and a
    // run whose checker diagnostics were all auto-fixed would otherwise report
    // zero and read as a checker that never spoke. One observed session had that
    // exact shape: three checker diagnostics, all fixed on the first pass.
    const afterProjectSet = new Set(env.projectDiagnostics || []);
    checkerDiagCount = Math.max(checkerDiagCount, filtered.filter((d) => !afterProjectSet.has(d)).length);
  }

  // The checker, the project rules and the post-fix merge each emit in their own
  // order (file walk order is filesystem-dependent), so sort once here to make
  // the output stable across platforms and runs.
  filtered = sortDiagnostics(filtered);

  // Issue #614: on a project with no build output yet, "Cannot find module
  // 'BuildProfile'" is a build-order problem, not a code problem — say so
  // instead of leaving the raw diagnostic to mislead.
  const bpHint = buildProfileNotBuiltHint(args.project);
  if (bpHint) {
    for (const d of filtered) {
      if (d.severity === 'error' && /Cannot find module 'BuildProfile'/.test(d.message || '')) {
        d.message = `${d.message.replace(/\.$/, '')}. ${bpHint}`;
      }
    }
  }

  const errorCount = filtered.filter(d => d.severity === 'error').length;
  const warnCount = filtered.filter(d => d.severity === 'warning').length;

  return {
    success: errorCount === 0,
    errors: filtered,
    fixed,
    alsoModified,
    summary: { errorCount, warnCount, fixedCount: fixed.length, checkerDiagCount, fileCount: files.length },
  };
}

// Newline-delimited JSON server. One warm process handles many checks, which is
// where the speedup lives: a cold run pays ~0.3s node boot + ~1.7s to require
// ets_checker + ~4.2s to build the SDK type graph, and only ~24ms per extra
// file. Re-entering `runCheck` in an already-warm process costs ~2s instead of
// ~6s. Protocol: one `{"ready":true}` line on startup, then one response line
// per request line, tagged with the request's `id`.
function serve(args) {
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + '\n');

  let buffer = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      handleRequest(line, args);
    }
  });
  process.stdin.on('end', () => { process.exitCode = 0; });
}

function handleRequest(line, args) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: null, error: `Malformed request: ${e.message}` }) + '\n');
    return;
  }

  if (req.shutdown) {
    process.stdout.write(JSON.stringify({ id: req.id, shutdown: true }) + '\n');
    process.exit(0);
  }

  // Every module-level cache keyed on paths or file contents must be dropped:
  // between two requests the model has edited files, added new ones, or switched
  // projects, and a stale entry would report diagnostics for content no longer
  // on disk. Both caches exist only to avoid re-reading within a single pass.
  // `fileDiagCache` is deliberately NOT cleared here — surviving across requests
  // is its entire purpose. It self-invalidates per file via closure hashes and
  // wholesale via the epoch.
  projectEtsFileCache.clear();
  stateFieldCache.clear();
  resolveModulePathsCache.clear();

  const result = (() => {
    try {
      return runCheck({
        project: req.project ? path.resolve(req.project) : '',
        files: Array.isArray(req.files) ? req.files : [],
        fix: req.fix !== false,
        cache: true,
        sdk: req.sdk ? path.resolve(req.sdk) : args.sdk,
        hms: req.hms ? path.resolve(req.hms) : args.hms,
      });
    } catch (e) {
      return { success: false, error: `Internal error: ${e && e.message}`, errors: [], summary: { errorCount: 0, warnCount: 0 } };
    }
  })();

  process.stdout.write(JSON.stringify({ id: req.id, result }) + '\n');

  // Each `etsStandaloneChecker` call rebuilds the program and leaves the previous
  // one (~125MB of AST and type objects) unreferenced but uncollected, so an
  // untouched daemon climbs past 650MB. Collecting here — after the response is
  // written, off the caller's wait path — holds the steady state near 230MB.
  // Requires --expose-gc; without it V8 still reclaims under pressure, just later.
  if (global.gc) global.gc();
}

function main() {
  const args = parseArgs(process.argv);
  if (args.serve) {
    serve(args);
    return;
  }
  const result = runCheck(args);
  process.stdout.write(JSON.stringify(result, null, 2));
  // 用 exitCode + 自然退出而非 process.exit：POSIX 上 stdout 指向 pipe 时写入
  // 是异步的，process.exit 可能截断未 flush 的大体积 JSON 结果。
  process.exitCode = result.error || (result.summary && result.summary.errorCount > 0) ? 1 : 0;
}

// Exported for unit testing without a DevEco SDK.
module.exports = {
  isBindingSyntaxFalsePositive, getStateFields, stateFieldCache,
  extractRename, buildFileEdits, buildImportHoist, applyEdits,
  extractDefaultImportBinding, buildComponentVersionEdits,
  computeLineStarts, offsetOf, GENERIC_SUGGESTION_BLACKLIST,
  extractMissingExport, extractNotAModule, namedImportsFrom, buildExportEdit, resolveModuleFile,
  buildModuleIndex, toRelativeSpecifier,
  parseJson5Loose, loadStringResourceKeys, validatePermissionsConfig,
  mergeIncrementalDiagnostics, spliceRevertedDiagnostics, restoreDroppedDiagnostics, revertAllTouched,
  validatePageEntryCount, validatePermissionNamesExist, loadCustomPermissionNames,
  validateComponentDecoratorConsistency, collectStructDecorators,
  V1_ONLY_MEMBER_DECORATORS, V2_ONLY_MEMBER_DECORATORS,
  validateObservedV2PropertyTypes, collectObservedV2ClassNames, V1_TYPE_SENSITIVE_DECORATORS,
  validateAppResources, loadAppResourceNames, APP_RESOURCE_INDEXED_KINDS,
  collectProjectEtsFiles, unionProjectFiles, projectEtsFileCache,
  STRUCT_DECL_RE, collectStructs,
  validateRegularPropertyInit, collectComponentRegularProperties,
  validateEntryBuildRootNode, CONTAINER_COMPONENTS,
  validateStructNameCollisions, isBuiltinComponentName, BUILTIN_LEAF_COMPONENTS,
  validateBuilderBodyStatements, collectBuilderBodies, BUILDER_LOCAL_DECL_RE,
  validateV2MemberDecoratorRules,
  validateNavDestinationRegistration, validateHideNavBarUsage,
  validateNavDestinationRoot, validateAppStorageV2Mixing,
  validateObjectLinkTypes, collectObservedClassNames,
  validateRouteMapProfile, ROUTE_MAP_ALLOWED_KEYS, ROUTE_MAP_REQUIRED_KEYS,
  validateRouteMapBuildFunction,
  validateResourceDirNames, QUALIFIER_RESOURCE_DIRS, TOP_LEVEL_RESOURCE_DIRS,
  parseArgs, runCheck, resolveSdk,
  readProjectSdkConfig, parseCompatibleSdkVersion, readSdkApiLevel,
  DEFAULT_SDK_INFO, DEFAULT_RUNTIME_OS,
  collectResolveModulePaths, readProjectModules, pickTargetNameForProduct,
  buildProfileNotBuiltHint, resolveModulePathsCache,
  closureHash, computeEpoch, resolveClosureDependency, collectAmbientDeclarations,
  fileDiagCache, invalidateFileDiagCache, dropFalsePositives, hashText,
  isOutsideProject, isDeclarationFile,
};

// Run as a CLI only when invoked directly (node arkts-check.cjs ...), not when required by tests.
if (require.main === module) {
  main();
}
