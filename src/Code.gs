/**
 * ═══════════════════════════════════════════════════════════
 *  GOVERNANCE ENGINE — Code.gs
 * ═══════════════════════════════════════════════════════════
 *
 *  TRIGGER ARCHITECTURE (Two-Layer):
 *
 *  Layer 1 — Simple triggers (always active, zero setup):
 *    • onEdit()  — type enforcement, header lock, updated_at stamping
 *    Uses toast() for notifications (alert() is blocked in simple triggers)
 *
 *  Layer 2 — Installable triggers (set up once via menu or sidebar):
 *    • onEditInstallable()   — same as above but with alert() dialogs
 *    • onChangeInstallable() — blocks column inserts when locked
 *
 *  IMPORTANT: Run "⚙ Initialize Triggers" from the Governance Engine menu
 *  once to activate Layer 2. Until then, Layer 1 keeps the engine running.
 */

// ─────────────────────────────────────────────
//  MENU
// ─────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Governance Engine')
    .addItem('Open Sidebar',              'showSidebar')
    .addItem('Validate Current Inputs',   'validateInputs')
    .addItem('Generate / Update Schema',  'triggerGenerateSchema')
    .addSeparator()
    .addItem('⚙ Initialize Triggers',    'initTriggers')
    .addToUi();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Data Governance Engine')
    .setWidth(300);
  SpreadsheetApp.getUi().showSidebar(html);
}

function triggerGenerateSchema() { generateSchema(); }

// ─────────────────────────────────────────────
//  TRIGGER INITIALIZATION
// ─────────────────────────────────────────────
/**
 * Run once from the menu after deploying to a new spreadsheet.
 * Also called automatically from toggleSchemaLock() (which runs with auth).
 */
function initTriggers() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const existing = ScriptApp.getUserTriggers(ss);

  // Wipe and re-create to avoid duplicates
  existing.forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'onEditInstallable' || fn === 'onChangeInstallable') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('onEditInstallable').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('onChangeInstallable').forSpreadsheet(ss).onChange().create();

  SpreadsheetApp.getUi().alert(
    '✅ Triggers initialized!\n\n' +
    'Full alert dialogs and column-insert blocking are now active.'
  );
}

// ═══════════════════════════════════════════════════════════
//  LAYER 1 — SIMPLE onEdit (always runs, uses toast)
// ═══════════════════════════════════════════════════════════
/**
 * This always runs. Handles core logic without UI alerts.
 * If installable triggers are active, onEditInstallable also fires
 * (providing the full alert dialog experience).
 */
function onEdit(e) {
  _handleEdit_(e, false); // false = use toast, not alert
}

// ═══════════════════════════════════════════════════════════
//  LAYER 2 — INSTALLABLE onEdit (requires initTriggers once)
// ═══════════════════════════════════════════════════════════
function onEditInstallable(e) {
  _handleEdit_(e, true); // true = use alert dialog
}

// ─────────────────────────────────────────────
//  SHARED EDIT HANDLER
// ─────────────────────────────────────────────
/**
 * Single source of truth for all onEdit behaviour.
 * @param {Object} e   - trigger event object
 * @param {boolean} ui - true = SpreadsheetApp.getUi().alert(), false = toast()
 */
function _handleEdit_(e, ui) {
  if (!e || !e.range) return;

  const sheet     = e.range.getSheet();
  const sheetName = sheet.getName();

  // ── Guard: do nothing on the Schema config sheet ──
  if (sheetName === 'Schema') {
    // Bust cache for the affected table so changes take effect immediately
    try {
      const tableCell = sheet.getRange(e.range.getRow(), 1).getValue();
      if (tableCell) CacheService.getScriptCache().remove('schema_' + tableCell);
    } catch (_) {}
    return;
  }

  // ── Guard: ignore multi-cell changes (paste/fill) ──
  if (e.range.getNumRows() > 1 || e.range.getNumColumns() > 1) return;

  const row = e.range.getRow();
  const col = e.range.getColumn();
  if (row < 2) {
    // ── Header row: block renames when locked ──
    if (row === 1 && isSchemaLocked()) {
      e.range.setValue(e.oldValue !== undefined ? e.oldValue : '');
      _notify_(
        ui,
        '⛔ SCHEMA IS LOCKED',
        'Column names cannot be renamed while the schema is locked.\nPlease unlock the schema first.'
      );
    }
    return;
  }

  // ── Load schema ──
  const cache  = CacheService.getScriptCache();
  const cached = cache.get('schema_' + sheetName);
  const schema = cached ? JSON.parse(cached) : fetchAndCacheSchema(sheetName, cache);
  if (!schema) return;

  // ── Identify column ──
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const colName = (headers[col - 1] || '').toString().trim();

  // ── Skip the updated_at column itself ──
  if (colName === CONFIG.updated_at_header) return;

  // ── Type checking ──
  if (colName && schema[colName]) {
    const typeStr = (schema[colName].type || '').toUpperCase();
    const rawVal  = (e.value !== undefined && e.value !== null) ? String(e.value) : '';

    if (rawVal !== '') {
      const result = standardizeLocales(rawVal, typeStr);

      if (result === null) {
        // Revert the invalid input
        e.range.setValue(e.oldValue !== undefined ? e.oldValue : '');
        _notify_(
          ui,
          '⛔ DATA TYPE MISMATCH',
          'Column "' + colName + '" expects: ' + typeStr + '\n' +
          '"' + rawVal + '" is not a valid ' + typeStr + '.\n' +
          'The value has been reverted.'
        );
        return; // Don't stamp updated_at on a reverted edit
      } else if (String(result) !== rawVal) {
        // Format the value (e.g. Indonesian float, date normalisation)
        e.range.setValue(result);
      }
    }
  }

  // ── Stamp updated_at with current timestamp ──
  const uIdx = headers.indexOf(CONFIG.updated_at_header);
  if (uIdx !== -1) {
    sheet.getRange(row, uIdx + 1).setValue(new Date());
  }
}

// ─────────────────────────────────────────────
//  NOTIFICATION HELPER
// ─────────────────────────────────────────────
function _notify_(ui, title, body) {
  const msg = title + '\n\n' + body;
  if (ui) {
    SpreadsheetApp.getUi().alert(msg);
  } else {
    SpreadsheetApp.getActiveSpreadsheet().toast(body, title, 6);
  }
}

// ═══════════════════════════════════════════════════════════
//  INSTALLABLE onChange — blocks column inserts when locked
// ═══════════════════════════════════════════════════════════
function onChangeInstallable(e) {
  if (!isSchemaLocked()) return;
  if (!e || e.changeType !== 'INSERT_COLUMN') return;

  const sheet = SpreadsheetApp.getActiveSheet();
  if (!sheet || sheet.getName() === 'Schema') return;

  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // Delete all blank-header columns right-to-left (newly inserted ones are blank)
  for (let c = lastCol; c >= 1; c--) {
    if ((headers[c - 1] || '').toString().trim() === '') {
      sheet.deleteColumn(c);
    }
  }

  SpreadsheetApp.getUi().alert(
    '⛔ SCHEMA IS LOCKED\n\n' +
    'Inserting columns is not allowed while the schema is locked.\n' +
    'The inserted column has been automatically removed.\n\n' +
    'Unlock the schema to modify table structure.'
  );
}

// ─────────────────────────────────────────────
//  TYPE COERCION
// ─────────────────────────────────────────────
/**
 * Returns sanitized value on success, null on mismatch.
 * Input is always treated as a string (from e.value in trigger context).
 */
function standardizeLocales(value, typeStr) {
  if (value === '' || value === null || value === undefined) return '';

  switch (typeStr) {
    case 'INTEGER': {
      // Strictly digits only (optional leading minus)
      if (!/^-?\d+$/.test(value.trim())) return null;
      const n = Number(value.trim());
      return Number.isFinite(n) ? n : null;
    }

    case 'FLOAT': {
      const s = value.trim();
      // Standard decimal
      if (/^-?\d+(\.\d+)?$/.test(s)) return Number(parseFloat(s).toFixed(2));
      // Indonesian format: 1.000.000,50
      const cleaned = s.replace(/\./g, '').replace(/,/g, '.');
      if (/^-?\d+(\.\d+)?$/.test(cleaned)) return Number(parseFloat(cleaned).toFixed(2));
      return null;
    }

    case 'TIMESTAMP': {
      const s = value.trim();
      // DD-MM-YYYY / DD/MM/YYYY / DD-MM-YY
      const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
      if (dmy) {
        let [, d, m, y] = dmy;
        if (y.length === 2) y = '20' + y;
        const dt = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
        return isNaN(dt.getTime()) ? null : dt;
      }
      // YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const dt = new Date(s);
        return isNaN(dt.getTime()) ? null : dt;
      }
      // Reject everything else (free text, random strings, etc.)
      return null;
    }

    case 'STRING':
      return String(value);

    default:
      return value; // Unknown type — pass through
  }
}

// ═══════════════════════════════════════════════════════════
//  BATCH VALIDATION  (Mandatory + Unique only)
// ═══════════════════════════════════════════════════════════
/**
 * Validates ALL rows that have at least one data cell filled.
 * updated_at is now always set by onEdit, so we validate all data rows.
 *
 * Rules checked:
 *   1. Mandatory — cell must not be empty
 *   2. Unique    — no duplicate values in that column
 *
 * Highlighting:
 *   • Only the specific failing CELLS are painted red.
 *   • Passing rows get their cell backgrounds cleared.
 *   • Completely empty rows are skipped entirely.
 */
function validateInputs() {
  const sheet     = SpreadsheetApp.getActiveSheet();
  const sheetName = sheet.getName();

  if (sheetName === 'Schema') {
    SpreadsheetApp.getUi().alert('Cannot run validation on the Schema sheet.');
    return false;
  }

  const cache  = CacheService.getScriptCache();
  const schema = JSON.parse(cache.get('schema_' + sheetName) || 'null')
              || fetchAndCacheSchema(sheetName, cache);

  if (!schema) {
    SpreadsheetApp.getUi().alert("No schema found. Run 'Generate / Update Schema' first.");
    return false;
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) { SpreadsheetApp.getUi().alert('No data to validate.'); return true; }

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const data    = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const uIdx    = headers.indexOf(CONFIG.updated_at_header); // may be -1 if absent

  // Pre-build column value arrays for duplicate detection
  const colArrays = {};
  headers.forEach((h, i) => {
    const safe = (h || '').toString().trim();
    if (safe) colArrays[safe] = data.map(r => String(r[i]).toLowerCase().trim());
  });

  const passed = [];
  const failed = []; // [{ row, failedCols: [colIdx] }]

  data.forEach((rowData, r) => {
    const sheetRow = r + 2;

    // Skip completely empty rows
    const hasData = rowData.some((v, i) => i !== uIdx && v !== '' && v !== null && v !== undefined);
    if (!hasData) return;

    const failedCols = [];

    headers.forEach((colName, c) => {
      if (c === uIdx) return; // skip updated_at
      const safe = (colName || '').toString().trim();
      const val  = rowData[c];
      const rule = schema[safe];
      if (!rule) return;

      // 1. Mandatory
      if (rule.is_mandatory && (val === '' || val === null || val === undefined)) {
        failedCols.push(c);
        return;
      }

      // 2. Unique
      if (rule.is_unique && val !== '' && val !== null && val !== undefined) {
        const count = (colArrays[safe] || []).filter(v => v === String(val).toLowerCase().trim()).length;
        if (count > 1) failedCols.push(c);
      }
    });

    if (failedCols.length === 0) passed.push(sheetRow);
    else failed.push({ row: sheetRow, failedCols });
  });

  // ── Clear backgrounds for all inspected rows, then paint failures ──
  [...passed, ...failed.map(f => f.row)].forEach(r => {
    sheet.getRange(r, 1, 1, lastCol).setBackground(null);
  });

  failed.forEach(f => {
    f.failedCols.forEach(c => {
      sheet.getRange(f.row, c + 1).setBackground(CONFIG.soft_rejection_color);
    });
  });

  // ── Report ──
  if (failed.length === 0 && passed.length === 0) {
    SpreadsheetApp.getUi().alert('No data rows found to validate.');
    return true;
  }

  let msg = 'Validation complete.\n\n'
          + '✅  Passed: ' + passed.length + ' row(s)\n'
          + '❌  Failed: ' + failed.length + ' row(s)\n';

  if (failed.length) {
    msg += '\nFailed rows:\n';
    const toCol = n => String.fromCharCode(64 + n); // 1→A, 2→B …
    failed.slice(0, 8).forEach(f => {
      const cells = f.failedCols.map(c => toCol(c + 1) + f.row).join(', ');
      msg += '  Row ' + f.row + ': ' + cells + '\n';
    });
    if (failed.length > 8) msg += '  ...and ' + (failed.length - 8) + ' more rows.';
  }

  SpreadsheetApp.getUi().alert(msg);
  return failed.length === 0;
}

function getSidebarData() {
  return { locked: isSchemaLocked() };
}
