// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  updated_at_header: 'updated_at',
  yellow_color:          '#FFF2CC',
  soft_rejection_color:  '#FCE8E6'
};

const SCHEMA_MAP = { TABLE: 0, COLUMN: 1, TYPE: 2, DESC: 3, MANDATORY: 4, UNIQUE: 5 };

// ─────────────────────────────────────────────
//  LOCK HELPERS
// ─────────────────────────────────────────────
function isSchemaLocked() {
  return PropertiesService.getScriptProperties().getProperty('SCHEMA_LOCKED') === 'true';
}

/**
 * Protects Row 1 on all non-Schema sheets AND installs/removes the
 * onChangeInstallable trigger so column-insert blocking is automatic.
 * Called from the sidebar — user is already authorised at this point.
 */
function toggleSchemaLock(state) {
  PropertiesService.getScriptProperties().setProperty('SCHEMA_LOCKED', state.toString());

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── Row 1 range protection (header rename blocking) ──
  ss.getSheets().forEach(sheet => {
    if (sheet.getName() === 'Schema') return;

    const existing = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
    let found = null;
    existing.forEach(p => { if (p.getDescription() === 'GovernanceEngine_RowLock') found = p; });

    if (state && !found) {
      const prot = sheet.getRange('1:1').protect().setDescription('GovernanceEngine_RowLock');
      prot.addEditor(Session.getEffectiveUser());
      prot.removeEditors(prot.getEditors());
      if (prot.canDomainEdit()) prot.setDomainEdit(false);
    } else if (!state && found) {
      found.remove();
    }
  });

  // ── onChange installable trigger (column-insert blocking) ──
  // Called from sidebar with user auth, so trigger creation always works here.
  const triggers    = ScriptApp.getUserTriggers(ss);
  const changeTrig  = triggers.find(t => t.getHandlerFunction() === 'onChangeInstallable');

  if (state && !changeTrig) {
    ScriptApp.newTrigger('onChangeInstallable').forSpreadsheet(ss).onChange().create();
  } else if (!state && changeTrig) {
    ScriptApp.deleteTrigger(changeTrig);
  }

  return state;
}

// ─────────────────────────────────────────────
//  CACHE + SCHEMA FETCH
// ─────────────────────────────────────────────
function fetchAndCacheSchema(sheetName, cache) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schemaSheet = ss.getSheetByName('Schema');
  if (!schemaSheet) return null;

  const lastRow = schemaSheet.getLastRow();
  if (lastRow < 2) return null;

  const data  = schemaSheet.getRange(2, 1, lastRow - 1, 6).getValues();
  const rules = {};

  data.forEach(row => {
    if (row[SCHEMA_MAP.TABLE] !== sheetName) return;
    const col = (row[SCHEMA_MAP.COLUMN] || '').toString().trim();
    if (!col) return;
    const mandatory = row[SCHEMA_MAP.MANDATORY];
    const unique    = row[SCHEMA_MAP.UNIQUE];
    rules[col] = {
      type:         (row[SCHEMA_MAP.TYPE] || 'STRING').toString().toUpperCase().trim(),
      is_mandatory: mandatory === true || String(mandatory).toLowerCase() === 'true',
      is_unique:    unique    === true || String(unique).toLowerCase()    === 'true'
    };
  });

  if (Object.keys(rules).length) {
    cache.put('schema_' + sheetName, JSON.stringify(rules), 21600);
    return rules;
  }
  return null;
}

// ─────────────────────────────────────────────
//  GENERATE / UPDATE SCHEMA  — Full Diff-Sync
// ─────────────────────────────────────────────
/**
 * Scans ALL sheets:
 *   • Forces an updated_at column onto every sheet that lacks one
 *   • Appends schema rows for new columns (including auto-added updated_at)
 *   • Removes schema rows for columns deleted from their sheet
 *   • Preserves TYPE / MANDATORY / UNIQUE the user set manually
 * Output is ordered by (table name, column position on the sheet).
 */
function generateSchema() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let schemaSheet = ss.getSheetByName('Schema');

  // ── Create Schema sheet if missing ──
  if (!schemaSheet) {
    schemaSheet = ss.insertSheet('Schema');
    schemaSheet.appendRow(['TABLE', 'COLUMN', 'TYPE', 'DESCRIPTION', 'MANDATORY', 'UNIQUE']);
    schemaSheet.getRange('A1:F1').setFontWeight('bold');
    schemaSheet.setFrozenRows(1);
  }

  // ── Read existing schema into lookup map ──
  const existingMap = {}; // { tableName: { colName: rowArray } }
  const lastExisting = schemaSheet.getLastRow();
  if (lastExisting > 1) {
    schemaSheet.getRange(2, 1, lastExisting - 1, 6).getValues().forEach(row => {
      const t = (row[SCHEMA_MAP.TABLE]  || '').toString().trim();
      const c = (row[SCHEMA_MAP.COLUMN] || '').toString().trim();
      if (!t || !c) return;
      if (!existingMap[t]) existingMap[t] = {};
      existingMap[t][c] = row;
    });
  }

  const orderedRows = [];
  let added = 0, removed = 0;

  ss.getSheets().forEach(sheet => {
    const tableName = sheet.getName();
    if (tableName === 'Schema') return;

    // ── Force-add updated_at column to the sheet if missing ──
    let lastCol = sheet.getLastColumn();
    if (lastCol === 0) return; // truly blank sheet, skip

    const currentHeaders = lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => (h || '').toString().trim())
      : [];

    if (!currentHeaders.includes(CONFIG.updated_at_header)) {
      sheet.getRange(1, lastCol + 1).setValue(CONFIG.updated_at_header);
      lastCol += 1; // update count
    }

    // Re-read headers after possible insertion
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    let dataRow = new Array(lastCol).fill('');
    if (sheet.getLastRow() >= 2) {
      dataRow = sheet.getRange(2, 1, 1, lastCol).getValues()[0];
    }

    const seenCols = new Set();

    headers.forEach((h, i) => {
      const colName = (h || '').toString().trim();
      if (!colName) return;
      seenCols.add(colName);

      if (existingMap[tableName] && existingMap[tableName][colName]) {
        // Preserve existing configuration
        orderedRows.push(existingMap[tableName][colName]);
      } else {
        // New / previously-unmapped column
        const cell = dataRow[i];
        let type = 'STRING';
        if (cell !== '' && cell !== null) {
          if      (Object.prototype.toString.call(cell) === '[object Date]') type = 'TIMESTAMP';
          else if (typeof cell === 'number') type = Number.isInteger(cell) ? 'INTEGER' : 'FLOAT';
          else if (typeof cell === 'boolean') type = 'BOOLEAN';
        }
        // updated_at is always TIMESTAMP, never mandatory or unique
        if (colName === CONFIG.updated_at_header) {
          type = 'TIMESTAMP';
          orderedRows.push([tableName, colName, type, 'Auto-managed row timestamp', false, false]);
        } else {
          const isMandatory = colName.includes('_id') || colName === 'id';
          const isUnique    = colName === 'id';
          orderedRows.push([tableName, colName, type, '', isMandatory, isUnique]);
        }
        added++;
        CacheService.getScriptCache().remove('schema_' + tableName);
      }
    });

    // Tally columns deleted from this sheet (they won't appear in orderedRows)
    if (existingMap[tableName]) {
      Object.keys(existingMap[tableName]).forEach(col => {
        if (!seenCols.has(col)) removed++;
      });
    }
  });

  // Append orphaned config blocks for tables/sheets that were entirely deleted
  // (we just drop them — they don't appear in orderedRows and they are not counted
  //  as "removed" above since that loop is per-sheet)

  // ── Write merged result back ──
  if (lastExisting > 1) {
    schemaSheet.getRange(2, 1, lastExisting - 1, 6).clearContent();
  }

  if (orderedRows.length > 0) {
    schemaSheet.getRange(2, 1, orderedRows.length, 6).setValues(orderedRows);

    const typeRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['INTEGER', 'FLOAT', 'STRING', 'TIMESTAMP', 'BOOLEAN'], true).build();
    schemaSheet.getRange(2, 3, orderedRows.length, 1).setDataValidation(typeRule);

    const boolRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['TRUE', 'FALSE'], true).build();
    schemaSheet.getRange(2, 5, orderedRows.length, 2).setDataValidation(boolRule);
  }

  // ── Report ──
  const parts = [];
  if (added)            parts.push('➕ ' + added   + ' column(s) added (including auto-injected updated_at).');
  if (removed)          parts.push('🗑 ' + removed  + ' column(s) removed (deleted from sheet).');
  if (!added && !removed) parts.push('✅ Schema is already fully in sync.');

  SpreadsheetApp.getUi().alert('Schema Sync Complete\n\n' + parts.join('\n'));
}
