/**
 * @OnlyCurrentDoc
 *
 * IMPORTANT — INSTALLABLE TRIGGER SETUP:
 * Simple triggers (onEdit) CANNOT call SpreadsheetApp.getUi().alert().
 * This script uses INSTALLABLE triggers registered via initTriggers().
 * Run initTriggers() ONCE from Extensions > Apps Script > Run after deploying.
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
    .addItem('⚙ Initialize Triggers (run once)', 'initTriggers')
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
//  TRIGGER INITIALIZATION — RUN ONCE
// ─────────────────────────────────────────────
/**
 * Registers installable triggers so that UI dialogs and full API access work inside onEdit.
 * Must be run manually once by going to Extensions > Apps Script and hitting Run.
 */
function initTriggers() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const existing = ScriptApp.getUserTriggers(ss);

  // Remove any stale duplicates first
  existing.forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'onEditInstallable' || fn === 'onChangeInstallable') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('onEditInstallable').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('onChangeInstallable').forSpreadsheet(ss).onChange().create();

  SpreadsheetApp.getUi().alert('✅ Triggers initialized successfully!\n\nonEdit and onChange installable triggers are now active.');
}

// ─────────────────────────────────────────────
//  INSTALLABLE onEdit — Full API access
// ─────────────────────────────────────────────
function onEditInstallable(e) {
  if (!e || !e.range) return;
  const sheet  = e.range.getSheet();
  const sheetName = sheet.getName();

  // 1. Block header renames when locked
  if (e.range.getRow() === 1 && sheetName !== 'Schema') {
    if (isSchemaLocked()) {
      e.range.setValue(e.oldValue !== undefined ? e.oldValue : '');
      SpreadsheetApp.getUi().alert(
        '⛔ SCHEMA IS LOCKED\n\n' +
        'Column names cannot be renamed while the schema is locked.\n' +
        'Please unlock the schema first.'
      );
      return;
    }
  }

  // 2. Bust cache when Schema tab itself is edited
  if (sheetName === 'Schema') {
    const tableCell = sheet.getRange(e.range.getRow(), 1).getValue();
    if (tableCell) CacheService.getScriptCache().remove('schema_' + tableCell);
    return;
  }

  // 3. Ignore multi-cell pastes/fills (can't reliably revert)
  if (e.range.getNumRows() > 1 || e.range.getNumColumns() > 1) return;

  const row = e.range.getRow();
  if (row === 1) return;

  // 4. Load schema
  const cache = CacheService.getScriptCache();
  let schema = null;
  const cached = cache.get('schema_' + sheetName);
  if (cached) {
    schema = JSON.parse(cached);
  } else {
    schema = fetchAndCacheSchema(sheetName, cache);
    if (!schema) return;
  }

  // 5. Identify column
  const col = e.range.getColumn();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colName = (headers[col - 1] || '').toString().trim();
  if (!colName || !schema[colName]) return;

  const typeStr = schema[colName].type ? schema[colName].type.toUpperCase() : '';
  // e.value is always a string from the trigger
  const rawVal  = (e.value !== undefined && e.value !== null) ? String(e.value) : '';
  if (rawVal === '') return; // Blank is fine; mandatory check is for Validate button

  const result = standardizeLocales(rawVal, typeStr);

  if (result === null) {
    // Type mismatch — revert and alert
    const oldVal = (e.oldValue !== undefined && e.oldValue !== null) ? e.oldValue : '';
    e.range.setValue(oldVal);
    SpreadsheetApp.getUi().alert(
      '⛔ DATA TYPE MISMATCH\n\n' +
      'Column "' + colName + '" expects type: ' + typeStr + '\n' +
      'The value "' + rawVal + '" is invalid and has been reverted.'
    );
  } else if (String(result) !== rawVal) {
    // Valid but needs formatting (e.g. Indonesian float, date normalisation)
    e.range.setValue(result);
  }
}

// ─────────────────────────────────────────────
//  INSTALLABLE onChange — Blocks column inserts
// ─────────────────────────────────────────────
function onChangeInstallable(e) {
  if (!isSchemaLocked()) return;
  if (!e || e.changeType !== 'INSERT_COLUMN') return;

  const sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() === 'Schema') return;

  // Find and delete all blank-header columns (the newly inserted one)
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // Delete from right to left to keep indices valid
  for (let c = lastCol; c >= 1; c--) {
    if ((headers[c - 1] || '').toString().trim() === '') {
      sheet.deleteColumn(c);
    }
  }

  SpreadsheetApp.getUi().alert(
    '⛔ SCHEMA IS LOCKED\n\n' +
    'Inserting columns is not allowed while the schema is locked.\n' +
    'The column was automatically removed.\n\n' +
    'Please unlock the schema to modify its structure.'
  );
}

// ─────────────────────────────────────────────
//  TYPE COERCION HELPER
// ─────────────────────────────────────────────
/**
 * Returns the sanitized value on success, null on type mismatch.
 * Value arriving here is always a string (from e.value).
 */
function standardizeLocales(value, typeStr) {
  if (value === '' || value === null || value === undefined) return '';

  switch (typeStr) {
    case 'INTEGER': {
      // Must be digits only (optionally leading minus)
      if (!/^-?\d+$/.test(value.trim())) return null;
      const n = Number(value.trim());
      if (!Number.isFinite(n)) return null;
      return n;
    }

    case 'FLOAT': {
      // If already a plain number string
      if (/^-?\d+(\.\d+)?$/.test(value.trim())) {
        return Number(parseFloat(value).toFixed(2));
      }
      // Indonesian format: 1.000.000,50
      const cleaned = value.trim().replace(/\./g, '').replace(/,/g, '.');
      if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
      return Number(parseFloat(cleaned).toFixed(2));
    }

    case 'TIMESTAMP': {
      const s = value.trim();
      // Accept DD-MM-YYYY, DD/MM/YYYY, DD-MM-YY, DD/MM/YY
      const dmyMatch = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
      if (dmyMatch) {
        let [, d, m, y] = dmyMatch;
        if (y.length === 2) y = '20' + y;
        const dt = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
        if (!isNaN(dt.getTime())) return dt;
        return null;
      }
      // Accept YYYY-MM-DD
      const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (isoMatch) {
        const dt = new Date(s);
        if (!isNaN(dt.getTime())) return dt;
        return null;
      }
      // Anything else (free text like "invalid_date", "23123sada") → reject
      return null;
    }

    case 'STRING':
      return String(value);

    default:
      return value;
  }
}

// ─────────────────────────────────────────────
//  BATCH VALIDATION (Mandatory + Unique only)
// ─────────────────────────────────────────────
function validateInputs() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const sheetName = sheet.getName();
  if (sheetName === 'Schema') {
    SpreadsheetApp.getUi().alert('Cannot run validation on the Schema sheet.');
    return false;
  }

  const cache = CacheService.getScriptCache();
  let schema = JSON.parse(cache.get('schema_' + sheetName) || 'null')
            || fetchAndCacheSchema(sheetName, cache);

  if (!schema) {
    SpreadsheetApp.getUi().alert("No schema found for this sheet. Run 'Generate / Update Schema' first.");
    return false;
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) { SpreadsheetApp.getUi().alert('No data to validate.'); return true; }

  const headers  = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const data     = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const uIdx     = headers.indexOf(CONFIG.updated_at_header);

  if (uIdx === -1) {
    SpreadsheetApp.getUi().alert("Column '" + CONFIG.updated_at_header + "' not found.");
    return false;
  }

  // Pre-build column value arrays for duplicate detection
  const colArrays = {};
  headers.forEach((h, i) => { colArrays[h] = data.map(r => String(r[i]).toLowerCase()); });

  const passed = [], failed = [];

  data.forEach((rowData, r) => {
    const sheetRow = r + 2;
    if (rowData[uIdx] !== '' && rowData[uIdx] !== null) return; // already stamped

    const isEmpty = rowData.every((v, i) => i === uIdx || v === '' || v === null);
    if (isEmpty) return;

    const errors = [];
    headers.forEach((colName, c) => {
      const safe  = (colName || '').toString().trim();
      const val   = rowData[c];
      const rule  = schema[safe];
      if (!rule) return;

      if (rule.is_mandatory && (val === '' || val === null || val === undefined)) {
        errors.push('Missing mandatory: ' + safe);
      }
      if (rule.is_unique && val !== '' && val !== null) {
        const count = colArrays[colName].filter(v => v === String(val).toLowerCase()).length;
        if (count > 1) errors.push('Duplicate in "' + safe + '": ' + val);
      }
    });

    if (errors.length) failed.push({ row: sheetRow, errors });
    else passed.push(sheetRow);
  });

  // Stamp passed rows
  const now = new Date();
  passed.forEach(r => {
    sheet.getRange(r, uIdx + 1).setValue(now);
    sheet.getRange(r, 1, 1, lastCol).setBackground(null);
  });

  // Highlight failed rows
  failed.forEach(f => {
    sheet.getRange(f.row, 1, 1, lastCol).setBackground(CONFIG.soft_rejection_color);
  });

  // Report
  if (failed.length === 0 && passed.length === 0) {
    SpreadsheetApp.getUi().alert('No unstamped rows found to validate.');
  } else {
    let msg = 'Validation complete.\n\n'
            + '✅ Stamped: ' + passed.length + ' rows\n'
            + '❌ Failed:  ' + failed.length + ' rows\n';
    if (failed.length) {
      msg += '\nFailed rows:\n';
      failed.slice(0, 5).forEach(f => { msg += 'Row ' + f.row + ': ' + f.errors.join(', ') + '\n'; });
      if (failed.length > 5) msg += '...and ' + (failed.length - 5) + ' more.';
    }
    SpreadsheetApp.getUi().alert(msg);
  }
  return failed.length === 0;
}

function getSidebarData() {
  return { locked: isSchemaLocked() };
}
