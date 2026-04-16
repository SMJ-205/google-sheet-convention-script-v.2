/**
 * ═══════════════════════════════════════════════════════════
 *  GOVERNANCE ENGINE — Code.gs
 * ═══════════════════════════════════════════════════════════
 *
 *  TRIGGER ARCHITECTURE (Two-Layer):
 *
 *  Layer 1 — Simple onEdit() [ALWAYS active, zero setup]:
 *    • Type enforcement, header lock, updated_at stamping
 *    • Uses toast() for notifications (alert blocked in simple triggers)
 *    • On type mismatch: clears to "" (blank) instead of reverting
 *
 *  Layer 2 — Installable triggers:
 *    • onEditInstallable()   — same + full alert() dialogs
 *    • onChangeInstallable() — blocks column inserts (auto-installed by toggleSchemaLock)
 *
 *  Run "⚙ Initialize Triggers" once to activate full alert dialogs.
 *  Column-insert blocking is auto-wired when toggling the schema lock.
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
    .addItem('🔍 Check Trigger Status',  'checkTriggers')
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
function initTriggers() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const existing = ScriptApp.getUserTriggers(ss);

  // Clean up ALL known handler names (including legacy ones)
  existing.forEach(t => {
    const fn = t.getHandlerFunction();
    if (['onEditInstallable','onChangeInstallable','handleStructuralChange'].includes(fn)) {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('onEditInstallable').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('onChangeInstallable').forSpreadsheet(ss).onChange().create();

  SpreadsheetApp.getUi().alert(
    '✅ Triggers initialized!\n\n' +
    'Two triggers registered:\n' +
    '• onEditInstallable (onEdit)\n' +
    '• onChangeInstallable (onChange)\n\n' +
    'Run "🔍 Check Trigger Status" from the menu to confirm.'
  );
}

/**
 * Diagnostic tool — shows all registered triggers for this spreadsheet.
 * Run this after Lock toggle to confirm onChangeInstallable is registered.
 */
function checkTriggers() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const triggers = ScriptApp.getUserTriggers(ss);
  const locked   = isSchemaLocked();

  if (triggers.length === 0) {
    SpreadsheetApp.getUi().alert(
      '⚠️ NO TRIGGERS REGISTERED\n\n' +
      'The onChange trigger is missing!\n\n' +
      'To fix: run "⚙ Initialize Triggers" from the Governance Engine menu,\n' +
      'OR toggle Lock OFF → ON from the Sidebar.'
    );
    return;
  }

  let msg = '🔍 Active triggers (' + triggers.length + '):\n\n';
  triggers.forEach(t => {
    const type = t.getEventType().toString();
    msg += '• ' + t.getHandlerFunction() + '  [' + type + ']\n';
  });
  msg += '\nSchema lock state: ' + (locked ? '🔒 LOCKED' : '🔓 UNLOCKED');

  const crashErr = PropertiesService.getScriptProperties().getProperty('ONCHANGE_ERROR');
  if (crashErr) {
    msg += '\n\n⚠ LATEST CRASH:\n' + crashErr;
  }
  
  const debugLog = PropertiesService.getScriptProperties().getProperty('ONCHANGE_DEBUG');
  if (debugLog) {
    msg += '\n\nℹ LATEST RUN:\n' + debugLog;
  }

  SpreadsheetApp.getUi().alert(msg);
}

// ═══════════════════════════════════════════════════════════
//  LAYER 1 — SIMPLE onEdit (always runs)
// ═══════════════════════════════════════════════════════════
function onEdit(e) {
  _handleEdit_(e, false); // false = toast notifications
}

// ═══════════════════════════════════════════════════════════
//  LAYER 2 — INSTALLABLE onEdit (requires initTriggers once)
// ═══════════════════════════════════════════════════════════
function onEditInstallable(e) {
  _handleEdit_(e, true); // true = alert() dialogs
}

// ─────────────────────────────────────────────
//  SHARED EDIT HANDLER
// ─────────────────────────────────────────────
function _handleEdit_(e, useAlerts) {
  if (!e || !e.range) return;

  const sheet     = e.range.getSheet();
  const sheetName = sheet.getName();

  // ── Schema tab edit → bust cache for that table row ──
  if (sheetName === 'Schema') {
    try {
      const tableCell = sheet.getRange(e.range.getRow(), 1).getValue();
      if (tableCell) CacheService.getScriptCache().remove('schema_' + tableCell);
    } catch (_) {}
    return;
  }

  // ── Skip multi-cell pastes in Layer 2 (handled by paste validation in validateInputs) ──
  // Layer 1 (simple trigger) already can't reliable handle multi-cell anyway.
  if (e.range.getNumRows() > 1 || e.range.getNumColumns() > 1) return;

  const row = e.range.getRow();
  const col = e.range.getColumn();

  // ── Row 1: block header renames when locked ──
  if (row === 1) {
    if (isSchemaLocked()) {
      e.range.setValue(e.oldValue !== undefined ? e.oldValue : '');
      _notify_(useAlerts,
        '⛔ SCHEMA IS LOCKED',
        'Column names cannot be renamed while the schema is locked.\nPlease unlock the schema first.'
      );
    }
    return;
  }

  if (row < 2) return;

  // ── Load schema ──
  const cache  = CacheService.getScriptCache();
  const cached = cache.get('schema_' + sheetName);
  const schema = cached ? JSON.parse(cached) : fetchAndCacheSchema(sheetName, cache);
  if (!schema) return;

  // ── Resolve column name ──
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const colName = (headers[col - 1] || '').toString().trim();

  // ── Skip updated_at column itself ──
  if (colName === CONFIG.updated_at_header) return;

  // ── Type check ──
  if (colName && schema[colName]) {
    const typeStr = (schema[colName].type || '').toUpperCase();
    const rawVal  = (e.value !== undefined && e.value !== null) ? String(e.value) : '';

    if (rawVal !== '') {
      const result = standardizeLocales(rawVal, typeStr);

      if (result === null) {
        // FIX 1: Clear to "" instead of reverting to old value
        e.range.setValue('');
        _notify_(useAlerts,
          '⛔ DATA TYPE MISMATCH',
          'Column "' + colName + '" expects: ' + typeStr + '\n' +
          '"' + rawVal + '" is not a valid ' + typeStr + '.\n\n' +
          'Cell has been cleared.'
        );
        // FIX 2: Also show the persistent detail toast (always, regardless of alert mode)
        SpreadsheetApp.getActiveSpreadsheet().toast(
          'Invalid ' + typeStr + ' in "' + colName + '": "' + rawVal + '" was cleared.',
          '⛔ Type Mismatch Detail',
          -1  // -1 = stays until user dismisses
        );
        return; // Don't stamp updated_at on a cleared cell
      } else if (String(result) !== rawVal) {
        e.range.setValue(result);
      }
    }
  }

  // ── Stamp updated_at with current timestamp on every valid row edit ──
  const uIdx = headers.indexOf(CONFIG.updated_at_header);
  if (uIdx !== -1) {
    sheet.getRange(row, uIdx + 1).setValue(new Date());
  }
}

// ─────────────────────────────────────────────
//  NOTIFICATION HELPER
// ─────────────────────────────────────────────
function _notify_(useAlerts, title, body) {
  if (useAlerts) {
    // Center-screen popup
    SpreadsheetApp.getUi().alert(title + '\n\n' + body);
  } else {
    // Bottom-right toast (persistent, -1 = stays until dismissed)
    SpreadsheetApp.getActiveSpreadsheet().toast(body, title, -1);
  }
}

// ═══════════════════════════════════════════════════════════
//  INSTALLABLE onChange — blocks INSERT & DELETE column
// ═══════════════════════════════════════════════════════════
function onChangeInstallable(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    
    // Log every execution to prove it fired
    props.setProperty('ONCHANGE_DEBUG', 'Fired at ' + new Date().toLocaleTimeString() + ' | Type: ' + (e ? e.changeType : 'none'));

    if (!isSchemaLocked()) return;

    // Guard against our own programmatic deletions
    if (props.getProperty('GE_DELETING') === 'true') return;

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return;

    if (e.changeType === 'INSERT_COLUMN') {
      let deleted = false;

      // getActiveSheet() is unreliable in background. Loop ALL sheets.
      ss.getSheets().forEach(sheet => {
        if (sheet.getName() === 'Schema') return;

        const maxCols = sheet.getMaxColumns();
        if (maxCols === 0) return;

        const headers = sheet.getRange(1, 1, 1, maxCols).getValues()[0];

        // Delete right-to-left
        for (let c = headers.length - 1; c >= 0; c--) {
          if ((headers[c] || '').toString().trim() === '') {
            // Set guard so this delete doesn't fire a REMOVE_COLUMN alert
            props.setProperty('GE_DELETING', 'true');
            try {
              sheet.deleteColumn(c + 1);
              deleted = true;
            } finally {
              props.deleteProperty('GE_DELETING');
            }
          }
        }
      });

      if (deleted) {
        SpreadsheetApp.getUi().alert(
          '⛔ SCHEMA IS LOCKED\n\n' +
          'Inserting columns is forbidden! The unauthorized column was automatically deleted.'
        );
      }

    } else if (e.changeType === 'REMOVE_COLUMN') {
      SpreadsheetApp.getUi().alert(
        '⛔ SCHEMA IS LOCKED\n\n' +
        'Deleting columns is forbidden! Please press Undo (Ctrl+Z) immediately or risk corrupting your table.'
      );
    }
  } catch (err) {
    PropertiesService.getScriptProperties().setProperty('ONCHANGE_ERROR', err.toString());
  }
}

// ─────────────────────────────────────────────
//  TYPE COERCION
// ─────────────────────────────────────────────
function standardizeLocales(value, typeStr) {
  if (value === '' || value === null || value === undefined) return '';

  switch (typeStr) {
    case 'INTEGER': {
      if (!/^-?\d+$/.test(value.trim())) return null;
      const n = Number(value.trim());
      return Number.isFinite(n) ? n : null;
    }
    case 'FLOAT': {
      const s = value.trim();
      if (/^-?\d+(\.\d+)?$/.test(s)) return Number(parseFloat(s).toFixed(2));
      const cleaned = s.replace(/\./g, '').replace(/,/g, '.');
      if (/^-?\d+(\.\d+)?$/.test(cleaned)) return Number(parseFloat(cleaned).toFixed(2));
      return null;
    }
    case 'TIMESTAMP': {
      const s = value.trim();
      const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
      if (dmy) {
        let [, d, m, y] = dmy;
        if (y.length === 2) y = '20' + y;
        const dt = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
        return isNaN(dt.getTime()) ? null : dt;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const dt = new Date(s);
        return isNaN(dt.getTime()) ? null : dt;
      }
      return null;
    }
    case 'STRING':
      return String(value);
    default:
      return value;
  }
}

// ═══════════════════════════════════════════════════════════
//  BATCH VALIDATION  (Mandatory + Unique + Paste Type Check)
// ═══════════════════════════════════════════════════════════
/**
 * Validates ALL rows with at least one data cell.
 * Also runs TYPE checking to catch paste-in data that bypassed onEdit.
 *
 * Per-cell failing reasons are tracked:
 *   • "mandatory"  — required field is empty
 *   • "duplicate"  — value exists elsewhere in a unique column
 *   • "type:FLOAT" — pasted value doesn't match expected type
 *
 * Only failing cells are highlighted (not full rows).
 * Passing rows have their backgrounds cleared.
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

  // Pre-build column arrays for duplicate checking
  const colArrays = {};
  headers.forEach((h, i) => {
    const safe = (h || '').toString().trim();
    if (safe) colArrays[safe] = data.map(r => String(r[i]).toLowerCase().trim());
  });

  const passed = [];
  const failed = []; // [{ row, cells: [{ colIdx, reason }] }]

  data.forEach((rowData, r) => {
    const sheetRow = r + 2;

    // Skip completely empty rows
    const hasData = rowData.some((v, i) => i !== uIdx && v !== '' && v !== null && v !== undefined);
    if (!hasData) return;

    const failedCells = []; // [{ colIdx, reason }]

    headers.forEach((colName, c) => {
      if (c === uIdx) return;
      const safe = (colName || '').toString().trim();
      const val  = rowData[c];
      const rule = schema[safe];
      if (!rule) return;

      const isEmpty = (val === '' || val === null || val === undefined);

      // 1. Mandatory
      if (rule.is_mandatory && isEmpty) {
        failedCells.push({ colIdx: c, reason: 'mandatory' });
        return; // Can't type-check an empty cell
      }

      if (!isEmpty) {
        // 2. Type check (catches paste-in values that bypassed onEdit)
        const typeStr  = (rule.type || '').toUpperCase();
        const strVal   = String(val).trim();
        // Skip type check on updated_at and BOOLEAN
        if (typeStr && typeStr !== 'BOOLEAN' && typeStr !== 'STRING') {
          const coerced = standardizeLocales(strVal, typeStr);
          if (coerced === null) {
            failedCells.push({ colIdx: c, reason: 'type:' + typeStr });
          }
        }

        // 3. Unique
        if (rule.is_unique) {
          const count = (colArrays[safe] || []).filter(v => v === String(val).toLowerCase().trim()).length;
          if (count > 1) failedCells.push({ colIdx: c, reason: 'not unique' });
        }
      }
    });

    if (failedCells.length === 0) passed.push(sheetRow);
    else failed.push({ row: sheetRow, cells: failedCells });
  });

  // ── Clear backgrounds for all inspected rows, then paint failing cells ──
  const allRows = [...passed, ...failed.map(f => f.row)];
  allRows.forEach(r => sheet.getRange(r, 1, 1, lastCol).setBackground(null));

  failed.forEach(f => {
    f.cells.forEach(fc => {
      sheet.getRange(f.row, fc.colIdx + 1).setBackground(CONFIG.soft_rejection_color);
    });
  });

  // ── Report ──
  if (failed.length === 0 && passed.length === 0) {
    SpreadsheetApp.getUi().alert('No data rows found to validate.');
    return true;
  }

  const toColLetter = n => String.fromCharCode(64 + n); // 1→A

  // Center-screen summary popup
  let alertMsg = 'Validation complete.\n\n'
              + '✅  Passed: ' + passed.length + ' row(s)\n'
              + '❌  Failed: ' + failed.length + ' row(s)';
  if (failed.length) {
    alertMsg += '\n\nFailed rows:\n';
    failed.slice(0, 8).forEach(f => {
      const cellRefs = f.cells.map(fc => toColLetter(fc.colIdx + 1) + f.row + ' (' + fc.reason + ')').join(', ');
      alertMsg += '  Row ' + f.row + ': ' + cellRefs + '\n';
    });
    if (failed.length > 8) alertMsg += '  ...and ' + (failed.length - 8) + ' more.';
  }
  SpreadsheetApp.getUi().alert(alertMsg);

  // Detailed scrollable dialog (non-blocking — user can dismiss and work in sheet)
  if (failed.length) {
    const errorLines = [];
    failed.forEach(f => {
      f.cells.forEach(fc => {
        const colName = headers[fc.colIdx] || ('Column ' + (fc.colIdx + 1));
        const reasonLabel = _friendlyReason_(fc.reason);
        errorLines.push('Row ' + f.row + ' &rarr; <b>' + colName + '</b>: ' + reasonLabel);
      });
    });
    _showErrorDialog_('Validation Errors (' + failed.length + ' row(s) failed)', errorLines);
  }

  return failed.length === 0;
}

function getSidebarData() {
  return { locked: isSchemaLocked() };
}

// ─────────────────────────────────────────────
//  ERROR DIALOG HELPERS
// ─────────────────────────────────────────────

/**
 * Shows a scrollable, non-blocking modeless dialog with error details.
 * The user can dismiss it and continue working in the sheet.
 */
function _showErrorDialog_(title, errorLines) {
  const rows = errorLines.map(l =>
    '<li style="padding:6px 0;border-bottom:1px solid #f0f0f0;line-height:1.5">' + l + '</li>'
  ).join('');

  const html =
    '<div style="font-family:Google Sans,Arial,sans-serif;padding:16px 20px;">' +
    '  <h3 style="margin:0 0 12px;color:#c62828;font-size:15px;">' + title + '</h3>' +
    '  <ul style="margin:0;padding-left:18px;list-style:disc;">' + rows + '</ul>' +
    '  <div style="margin-top:16px;text-align:right;">' +
    '    <button onclick="google.script.host.close()" ' +
    '      style="background:#1a73e8;color:#fff;border:none;padding:8px 20px;' +
    '             border-radius:4px;font-size:13px;cursor:pointer;">Dismiss</button>' +
    '  </div>' +
    '</div>';

  const output = HtmlService.createHtmlOutput(html)
    .setWidth(480)
    .setHeight(Math.min(120 + errorLines.length * 36, 480));

  SpreadsheetApp.getUi().showModelessDialog(output, title);
}

/**
 * Converts internal reason codes to user-friendly labels.
 */
function _friendlyReason_(reason) {
  if (reason === 'mandatory')  return '<span style="color:#c62828">⚠ Field is mandatory — cannot be empty</span>';
  if (reason === 'not unique') return '<span style="color:#e65100">⚠ Value is not unique — duplicate found</span>';
  if (reason.startsWith('type:')) {
    const t = reason.replace('type:', '');
    return '<span style="color:#6a1b9a">⚠ Invalid type — expected ' + t + '</span>';
  }
  return reason;
}
