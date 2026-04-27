'use strict';

// scripts/generate-handlers.js
// Generates typed IPC handler modules + smoke tests for all 30 synced tables
// except station_programming (the hand-written canonical reference).
//
// Run:      node scripts/generate-handlers.js
// Dry run:  node scripts/generate-handlers.js --dry-run
//
// Reads templates from scripts/templates/*.tpl — fails clearly if missing.
// Outputs:
//   electron/sync/handlers/<tableName>.js     (30 files)
//   scripts/smoke-<tableName>-handlers.js     (30 files)
//   electron/sync/handlers/index.js           (aggregator)
//   electron/preload-handlers.js              (preload factory)

const path = require('path');
const fs   = require('fs');

// ── Paths ─────────────────────────────────────────────────────────────────────

const ROOT         = path.resolve(__dirname, '..');
const TEMPLATES    = path.join(__dirname, 'templates');
const HANDLERS_DIR = path.join(ROOT, 'electron', 'sync', 'handlers');
const SCRIPTS_DIR  = __dirname;

// ── CLI flags ─────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');

// ── Load registry ─────────────────────────────────────────────────────────────

const { REGISTRY } = require('../electron/sync/synced-tables');

// ── Case helpers ──────────────────────────────────────────────────────────────

function toPascal(snake) {
  return snake.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join('');
}

function toCamel(snake) {
  const p = toPascal(snake);
  return p[0].toLowerCase() + p.slice(1);
}

// ── Template loader ───────────────────────────────────────────────────────────

function loadTemplate(name) {
  const tplPath = path.join(TEMPLATES, name);
  if (!fs.existsSync(tplPath)) {
    throw new Error(
      `Template not found: ${tplPath}\n` +
      `  → Create the templates in scripts/templates/ before running the generator`
    );
  }
  return fs.readFileSync(tplPath, 'utf8');
}

// ── Variable substitution ─────────────────────────────────────────────────────
// Replaces all {{KEY}} markers in template with vars[KEY].
// Throws on unknown keys so templates can't silently emit unreplaced markers.

function render(template, vars) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    if (!(key in vars)) {
      throw new Error(`Unknown template variable {{${key}}} — add it to computeVars() or the coordination vars map`);
    }
    return vars[key];
  });
}

// ── Per-table variable computation ───────────────────────────────────────────

// Columns never patchable regardless of table
const NEVER_PATCHABLE = new Set(['id', 'uuid', 'created_at', 'station_id', 'deleted_at', 'added_at']);

function computeVars(tableName, entry) {
  const cols      = Object.keys(entry.columns);
  const pkCols    = entry.primaryKey;
  const scope     = entry.scope;
  const pascal    = toPascal(tableName);
  const camel     = toCamel(tableName);
  const installFn = 'install' + pascal;

  const hasStationIdCol = cols.includes('station_id');

  // All 30 generated tables have a uuid column (verified during discovery).
  // Always use uuid as the IPC lookup key.
  const lookupCol = 'uuid';

  // INSERT cols: every column except 'id' (auto-increment PK).
  const insertCols = cols.filter(c => c !== 'id');

  // PATCHABLE: all cols minus immutable fields and declared PK columns.
  const nonPatchable = new Set([...NEVER_PATCHABLE, ...pkCols]);
  const patchable    = cols.filter(c => !nonPatchable.has(c));

  // station_id expressions for withMutation.
  // Install-scoped or tables without a station_id column → null per [N-89].
  const useStationId   = scope === 'station' && hasStationIdCol;
  const mutSidCreate   = useStationId ? 'payload.station_id'                 : 'null';
  const mutSidUpdate   = useStationId ? 'existing.station_id'                : 'null';
  const mutSidDelete   = useStationId ? '(stationId ?? existing.station_id)' : 'null';

  return {
    TABLE_NAME:          tableName,
    PASCAL_NAME:         pascal,
    CAMEL_NAME:          camel,
    INSTALL_FN:          installFn,
    SCOPE:               scope,
    HAS_STATION_ID_COL:  String(hasStationIdCol),
    LOOKUP_COL:          lookupCol,
    PATCHABLE_COLS_JSON: JSON.stringify(patchable),
    ALL_COLS_JSON:       JSON.stringify(cols),
    INSERT_COLS:         insertCols.join(', '),
    INSERT_PLACEHOLDERS: insertCols.map(() => '?').join(', '),
    INSERT_ROW_BINDINGS: insertCols.map(c => `row.${c}`).join(', '),
    MUT_SID_CREATE:      mutSidCreate,
    MUT_SID_UPDATE:      mutSidUpdate,
    MUT_SID_DELETE:      mutSidDelete,
  };
}

// ── Preload namespace block ───────────────────────────────────────────────────
// Generates one camelCase namespace entry for preload-handlers.js.
// Station-scoped list() takes stationId; install-scoped list() takes opts only.

function buildPreloadNamespace(camelName, tableName, scope) {
  const ch = tableName; // IPC channel prefix = table name (snake_case)
  const i  = '    ';    // inner indent (4 spaces inside the namespace object)
  if (scope === 'station') {
    return [
      `  ${camelName}: {`,
      `${i}list:    (stationId, opts) => ipcRenderer.invoke('${ch}:list',      stationId, opts),`,
      `${i}getById: (uuid)            => ipcRenderer.invoke('${ch}:get-by-id', uuid),`,
      `${i}create:  (payload)         => ipcRenderer.invoke('${ch}:create',    payload),`,
      `${i}update:  (uuid, patch)     => ipcRenderer.invoke('${ch}:update',    uuid, patch),`,
      `${i}delete:  (uuid, stationId) => ipcRenderer.invoke('${ch}:delete',    uuid, stationId),`,
      `  },`,
    ].join('\n');
  } else {
    return [
      `  ${camelName}: {`,
      `${i}list:    (opts)            => ipcRenderer.invoke('${ch}:list',      opts),`,
      `${i}getById: (uuid)            => ipcRenderer.invoke('${ch}:get-by-id', uuid),`,
      `${i}create:  (payload)         => ipcRenderer.invoke('${ch}:create',    payload),`,
      `${i}update:  (uuid, patch)     => ipcRenderer.invoke('${ch}:update',    uuid, patch),`,
      `${i}delete:  (uuid)            => ipcRenderer.invoke('${ch}:delete',    uuid),`,
      `  },`,
    ].join('\n');
  }
}

// ── File emitter ──────────────────────────────────────────────────────────────

function emit(filePath, content) {
  const rel = path.relative(ROOT, filePath);
  if (DRY_RUN) {
    console.log(`  [dry-run] ${rel} (${content.length} bytes)`);
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  wrote: ${rel} (${content.length} bytes)`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  console.log(DRY_RUN
    ? '[generate-handlers] DRY RUN — no files will be written'
    : '[generate-handlers] generating...'
  );
  console.log('');

  // Load all templates up front — fail fast with clear message if any are missing
  const HANDLER_TPL = {
    station: loadTemplate('handler-station-scoped.js.tpl'),
    install: loadTemplate('handler-install-scoped.js.tpl'),
  };
  const SMOKE_TPL = {
    station: loadTemplate('smoke-station-scoped.js.tpl'),
    install: loadTemplate('smoke-install-scoped.js.tpl'),
  };
  const INDEX_TPL   = loadTemplate('index.js.tpl');
  const PRELOAD_TPL = loadTemplate('preload-handlers.js.tpl');

  // Collect tables: skip station_programming; sort alphabetically for determinism
  const tables = Object.entries(REGISTRY)
    .filter(([name]) => name !== 'station_programming')
    .sort(([a], [b]) => a.localeCompare(b));

  console.log(`Tables to generate: ${tables.length}`);
  console.log('');

  const requireLines     = [];  // accumulated for index.js  {{REQUIRE_LINES}}
  const installCallLines = [];  // accumulated for index.js  {{INSTALL_LINES}}
  const namespaceBlocks  = [];  // accumulated for preload-handlers.js  {{NAMESPACE_BLOCKS}}

  for (const [tableName, entry] of tables) {
    const vars  = computeVars(tableName, entry);
    const scope = entry.scope;

    // Handler file: electron/sync/handlers/<tableName>.js
    emit(
      path.join(HANDLERS_DIR, `${tableName}.js`),
      render(HANDLER_TPL[scope], vars)
    );

    // Smoke file: scripts/smoke-<tableName>-handlers.js
    emit(
      path.join(SCRIPTS_DIR, `smoke-${tableName}-handlers.js`),
      render(SMOKE_TPL[scope], vars)
    );

    // Accumulate coordination data
    requireLines.push(`const { ${vars.INSTALL_FN} } = require('./${tableName}');`);
    installCallLines.push(`  ${vars.INSTALL_FN}(ipcMain, db);`);
    namespaceBlocks.push(buildPreloadNamespace(vars.CAMEL_NAME, tableName, scope));
  }

  // electron/sync/handlers/index.js — calls installStationProgramming + all 30 generated
  emit(
    path.join(HANDLERS_DIR, 'index.js'),
    render(INDEX_TPL, {
      REQUIRE_LINES: requireLines.join('\n'),
      INSTALL_LINES: installCallLines.join('\n'),
    })
  );

  // electron/preload-handlers.js — factory returning all 31 namespaces
  emit(
    path.join(ROOT, 'electron', 'preload-handlers.js'),
    render(PRELOAD_TPL, {
      NAMESPACE_BLOCKS: namespaceBlocks.join('\n'),
    })
  );

  const totalFiles = tables.length * 2 + 2;
  console.log('');
  console.log(`[generate-handlers] ${DRY_RUN ? 'dry run complete' : 'done'} — ${totalFiles} files ${DRY_RUN ? 'would be' : ''} written`);
  console.log(`  ${tables.length} handler files  → electron/sync/handlers/`);
  console.log(`  ${tables.length} smoke files    → scripts/`);
  console.log(`  1 aggregator     → electron/sync/handlers/index.js`);
  console.log(`  1 preload        → electron/preload-handlers.js`);
}

main();
