/**
 * @OnlyCurrentDoc
 *
 * TRIGGER ARCHITECTURE:
 * Simple onOpen() always runs — it auto-initializes installable triggers
 * if they are missing (e.g. after a sheet is duplicated).
 *
 * Installable triggers (onEditInstallable, onChangeInstallable) are required
 * for SpreadsheetApp.getUi().alert() and full API access.
 */

// ─────────────────────────────────────────────
//  MENU + AUTO TRIGGER CHECK
// ─────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Governance Engine')
    .addItem('Open Sidebar',             'showSidebar')
    .addItem('Validate Current Inputs',  'validateInputs')
    .addItem('Generate / Update Schema', 'triggerGenerateSchema')
    .addSeparator()
    .addItem('⚙ Initialize Triggers',   'initTriggers')
    .addToUi();

  // Auto-check: if installable triggers are missing (e.g. after duplication),
  // silently attempt to register them. This works because the user opening the
  // sheet has already authorised the script.
  _ensureTriggersExist_();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Data Governance Engine')
    .setWidth(300);
  SpreadsheetApp.getUi().showSidebar(html);
}

function triggerGenerateSchema() { generateSchema(); }

// ─────────────────────────────────────────────
//  TRIGGER MANAGEMENT
// ─────────────────────────────────────────────

/**
 * Called silently from onOpen to self-heal on duplicated sheets.
 * Does NOT show any UI — safe to call from a simple trigger context.
 */
function _ensureTriggersExist_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const triggers = ScriptApp.getUserTriggers(ss);
    const fns = triggers.map(t => t.getHandlerFunction());
    if (!fns.includes('onEditInstallable')) {
      ScriptApp.newTrigger('onEditInstallable').forSpreadsheet(ss).onEdit().create();
    }
    if (!fns.includes('onChangeInstallable')) {
      ScriptApp.newTrigger('onChangeInstallable').forSpreadsheet(ss).onChange().create();
    }
  } catch (e) {
    // Silently fail — user hasn't authorised yet. They can run initTriggers manually.
  }
}

/**
 * Explicit menu item — shows confirmation. Useful after first install or
 * when auto-init fails due to missing authorization.
 */
function initTriggers() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const existing = ScriptApp.getUserTriggers(ss);

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
    'onEdit and onChange installable triggers are active.\n' +
    'Type enforcement and schema lock are now fully operational.'
  );
}

// ─────────────────────────────────────────────
//  INSTALLABLE onEdit
// ─────────────────────────────────────────────
function onEditInstallable(e) {
  if (!e || !e.range) return;
  const sheet     = e.range.getSheet();
  const sheetName = sheet.getName();

  // ── 1. Block header rename when locked ──
  if (e.range.getRow() === 1 && sheetName !== 'Schema' && isSchemaLocked()) {
    e.range.setValue(e.oldValue !== undefined ? e.oldValue : '');
    SpreadsheetApp.getUi().alert(
      '⛔ SCHEMA IS LOCKED\n\n' +
      'Column names cannot be renamed while the schema is locked.\n' +
      'Please unlock the schema first.'
    );
    return;
  }

  // ── 2. Schema tab edit → bust cache for that table ──
  if (sheetName === 'Schema') {
    const tableCell = sheet.getRange(e.range.getRow(), 1).getValue();
    if (tableCell) CacheService.getScriptCache().remove('schema_' + tableCell);
    return;
  }

  // ── 3. Skip multi-cell pastes ──
  if (e.range.getNumRows() > 1 || e.range.getNumColumns() > 1) return;

  const row = e.range.getRow();
  if (row === 1) return;

  // ── 4. Load schema ──
  const cache  = CacheService.getScriptCache();
  const cached = cache.get('schema_' + sheetName);
  const schema = cached ? JSON.parse(cached) : fetchAndCacheSchema(sheetName, cache);
  if (!schema) return;

  // ── 5. Identify the edited column ──
  const col     = e.range.getColumn();
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const colName = (headers[col - 1] || '').toString().trim();

  // ── 6. Update updated_at for this row (tracks every edit) ──
  //    Skip if the edited column IS updated_at itself, or if no updated_at column exists
  const uIdx = headers.indexOf(CONFIG.updated_at_header);
  if (uIdx !== -1 && colName !== CONFIG.updated_at_header) {
    // Reset updated_at so row becomes "unstamped" and needs re-validation
    sheet.getRange(row, uIdx + 1).setValue('');
  }

  // ── 7. Type-check the edited cell ──
  if (!colName || !schema[colName] || colName === CONFIG.updated_at_header) return;

  const typeStr = (schema[colName].type || '').toUpperCase();
  const rawVal  = (e.value !== undefined && e.value !== null) ? String(e.value) : '';
  if (rawVal === '') return;

  const result = standardizeLocales(rawVal, typeStr);

  if (result === null) {
    e.range.setValue(e.oldValue !== undefined ? e.oldValue : '');
    SpreadsheetApp.getUi().alert(
      '⛔ DATA TYPE MISMATCH\n\n' +
      'Column "' + colName + '" expects: ' + typeStr + '\n' +
      '"' + rawVal + '" is not a valid ' + typeStr + '.\n\n' +
      'The value has been reverted.'
    );
  } else if (String(result) !== rawVal) {
    e.range.setValue(result);
  }
}

// ─────────────────────────────────────────────
//  INSTALLABLE onChange — blocks column inserts
// ─────────────────────────────────────────────
function onChangeInstallable(e) {
  if (!isSchemaLocked()) return;
  if (!e || e.changeType !== 'INSERT_COLUMN') return;

  const sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() === 'Schema') return;

  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // Delete blank-header columns right-to-left (newly inserted ones have no header)
  for (let c = lastCol; c >= 1; c--) {
    if ((headers[c - 1] || '').toString().trim() === '') {
      sheet.deleteColumn(c);
    }
  }

  SpreadsheetApp.getUi().alert(
    '⛔ SCHEMA IS LOCKED\n\n' +
    'Inserting columns is forbidden while the schema is locked.\n' +
    'The inserted column has been automatically removed.\n\n' +
    'Unlock the schema to modify its structure.'
  );
}

// ─────────────────────────────────────────────
//  TYPE COERCION
// ─────────────────────────────────────────────
/**
 * Returns sanitized value on success, null on type mismatch.
 * Input value is always a string (from e.value in trigger context).
 */
function standardizeLocales(value, typeStr) {
  if (value === '' || value === null || value === undefined) return '';

  switch (typeStr) {
    case 'INTEGER': {
      if (!/^-?\d+$/.test(value.trim())) return null;
      const n = Number(value.trim());
      if (!Number.isFinite(n)) return null;
      return n;
    }
    case 'FLOAT': {
      if (/^-?\d+(\.\d+)?$/.test(value.trim())) {
        return Number(parseFloat(value).toFixed(2));
      }
      // Indonesian: 1.000.000,50
      const cleaned = value.trim().replace(/\./g, '').replace(/,/g, '.');
      if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
      return Number(parseFloat(cleaned).toFixed(2));
    }
    case 'TIMESTAMP': {
      const s = value.trim();
      // DD-MM-YYYY or DD/MM/YYYY or DD-MM-YY
      const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
      if (dmy) {
        let [, d, m, y] = dmy;
        if (y.length === 2) y = '20' + y;
        const dt = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
        if (!isNaN(dt.getTime())) return dt;
        return null;
      }
      // YYYY-MM-DD
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
        const dt = new Date(s);
        if (!isNaN(dt.getTime())) return dt;
        return null;
      }
      // Reject everything else
      return null;
    }
    case 'STRING':
      return String(value);
    default:
      return value;
  }
}

// ─────────────────────────────────────────────
//  BATCH VALIDATION  (Mandatory + Unique only)
// ─────────────────────────────────────────────
/**
 * "Unstamped" definition:
 *   Any row that has at least one non-empty data cell AND where updated_at is blank.
 *   updated_at is cleared by onEditInstallable whenever any data cell in that row is edited,
 *   so this naturally captures rows edited since the last validation run.
 *
 * Highlighting rules:
 *   • Only highlight specific CELLS (not entire rows) that violate a rule.
 *   • Completely empty rows are ignored entirely.
 *   • Passing rows (no errors) get updated_at stamped and any prior highlights cleared.
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
  const uIdx    = headers.indexOf(CONFIG.updated_at_header);

  if (uIdx === -1) {
    SpreadsheetApp.getUi().alert("Column '" + CONFIG.updated_at_header + "' not found.");
    return false;
  }

  // Pre-build per-column value arrays for duplicate detection
  const colArrays = {};
  headers.forEach((h, i) => {
    colArrays[(h || '').toString().trim()] = data.map(r => String(r[i]).toLowerCase());
  });

  const passed = [];
  const failed = []; // { row, failedCells: [{colIdx, reason}] }

  data.forEach((rowData, r) => {
    const sheetRow = r + 2;

    // Skip already-stamped rows
    if (rowData[uIdx] !== '' && rowData[uIdx] !== null && rowData[uIdx] !== undefined) return;

    // Skip completely empty rows (all non-updated_at cells are blank)
    const hasData = rowData.some((v, i) => i !== uIdx && v !== '' && v !== null && v !== undefined);
    if (!hasData) return;

    const failedCells = [];

    headers.forEach((colName, c) => {
      if (c === uIdx) return; // skip updated_at itself
      const safe = (colName || '').toString().trim();
      const val  = rowData[c];
      const rule = schema[safe];
      if (!rule) return;

      // Mandatory check
      if (rule.is_mandatory && (val === '' || val === null || val === undefined)) {
        failedCells.push({ colIdx: c, reason: 'mandatory' });
      }

      // Unique check
      if (rule.is_unique && val !== '' && val !== null && val !== undefined) {
        const count = (colArrays[safe] || []).filter(v => v === String(val).toLowerCase()).length;
        if (count > 1) failedCells.push({ colIdx: c, reason: 'duplicate' });
      }
    });

    if (failedCells.length === 0) {
      passed.push(sheetRow);
    } else {
      failed.push({ row: sheetRow, failedCells });
    }
  });

  // ── Stamp passed rows + clear any prior highlights ──
  const now = new Date();
  passed.forEach(r => {
    sheet.getRange(r, uIdx + 1).setValue(now);
    // Clear the entire row's background (remove any old error highlights)
    sheet.getRange(r, 1, 1, lastCol).setBackground(null);
  });

  // ── Highlight only the FAILING CELLS (not the whole row) ──
  // First, clear backgrounds of failed rows so old marks don't linger
  failed.forEach(f => {
    sheet.getRange(f.row, 1, 1, lastCol).setBackground(null);
    // Then paint only the cells that failed
    f.failedCells.forEach(fc => {
      sheet.getRange(f.row, fc.colIdx + 1).setBackground(CONFIG.soft_rejection_color);
    });
  });

  // ── Report ──
  if (failed.length === 0 && passed.length === 0) {
    SpreadsheetApp.getUi().alert('No unstamped rows with data were found to validate.');
    return true;
  }

  let msg = 'Validation complete.\n\n'
          + '✅ Stamped:  ' + passed.length + ' row(s)\n'
          + '❌ Failed:   ' + failed.length + ' row(s)\n';

  if (failed.length) {
    msg += '\nFailed rows:\n';
    const colLetters = col => String.fromCharCode(64 + col); // 1→A, 2→B …
    failed.slice(0, 6).forEach(f => {
      const cellRefs = f.failedCells.map(fc => colLetters(fc.colIdx + 1) + f.row).join(', ');
      msg += 'Row ' + f.row + ' → ' + cellRefs + '\n';
    });
    if (failed.length > 6) msg += '...and ' + (failed.length - 6) + ' more rows.';
  }

  SpreadsheetApp.getUi().alert(msg);
  return failed.length === 0;
}

function getSidebarData() {
  return { locked: isSchemaLocked() };
}
