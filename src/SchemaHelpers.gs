/**
 * Constants & Settings
 */
const CONFIG = {
  updated_at_header: "updated_at",
  yellow_color: "#FFF2CC",
  soft_rejection_color: "#FCE8E6"
};

const SCHEMA_MAP = {
  TABLE: 0,
  COLUMN: 1,
  TYPE: 2,
  MANDATORY: 4,
  UNIQUE: 5
};

function isSchemaLocked() {
  return PropertiesService.getScriptProperties().getProperty("SCHEMA_LOCKED") === "true";
}

function toggleSchemaLock(state) {
  PropertiesService.getScriptProperties().setProperty("SCHEMA_LOCKED", state.toString());
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  
  sheets.forEach(sheet => {
    if (sheet.getName() === "Schema") return;
    
    const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
    let row1Protected = false;
    
    protections.forEach(p => {
       if (p.getDescription() === 'GovernanceEngine_RowLock') {
          if (!state) p.remove(); 
          row1Protected = true;
       }
    });
    
    if (state && !row1Protected) {
       const lockRange = sheet.getRange("1:1"); 
       const protection = lockRange.protect().setDescription('GovernanceEngine_RowLock');
       
       const me = Session.getEffectiveUser();
       protection.addEditor(me);
       protection.removeEditors(protection.getEditors());
       if (protection.canDomainEdit()) {
         protection.setDomainEdit(false);
       }
    }
  });

  return state;
}

function fetchAndCacheSchema(sheetName, cache) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schemaSheet = ss.getSheetByName("Schema");
  if (!schemaSheet) return null; 
  
  const lastRow = schemaSheet.getLastRow();
  if (lastRow < 2) return null; 
  
  const data = schemaSheet.getRange(2, 1, lastRow - 1, 6).getValues();
  const rules = {};
  
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    
    if (row[SCHEMA_MAP.TABLE] === sheetName) {
      let isMandatory = row[SCHEMA_MAP.MANDATORY] === true || String(row[SCHEMA_MAP.MANDATORY]).toLowerCase() === "true" || row[SCHEMA_MAP.MANDATORY] === 1;
      let isUnique = row[SCHEMA_MAP.UNIQUE] === true || String(row[SCHEMA_MAP.UNIQUE]).toLowerCase() === "true" || row[SCHEMA_MAP.UNIQUE] === 1;
      
      rules[row[SCHEMA_MAP.COLUMN]] = {
        type: row[SCHEMA_MAP.TYPE],
        is_mandatory: isMandatory,
        is_unique: isUnique
      };
    }
  }
  
  if (Object.keys(rules).length > 0) {
    cache.put("schema_" + sheetName, JSON.stringify(rules), 21600); 
    return rules;
  }
  return null;
}

/**
 * Auto-Generates the Schema based on all active sheets dynamically dynamically scanning and updating.
 * Preserves existings configurations but appends new missing ones perfectly sorted by Table and Column Sequence.
 */
function generateSchema() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let schemaSheet = ss.getSheetByName("Schema");
  let existingData = [];
  
  // Create Schema Table if entirely missing
  if (!schemaSheet) {
    schemaSheet = ss.insertSheet("Schema");
    schemaSheet.appendRow(["TABLE", "COLUMN", "TYPE", "DESCRIPTION", "MANDATORY", "UNIQUE"]);
    schemaSheet.getRange("A1:F1").setFontWeight("bold");
    schemaSheet.setFrozenRows(1);
  } else {
    // Slurp all existing configurations
    const lastRow = schemaSheet.getLastRow();
    if (lastRow > 1) {
      existingData = schemaSheet.getRange(2, 1, lastRow - 1, 6).getValues();
    }
  }

  // Lookup dictionary for previous configurations so we don't wipe out manual type edits
  const existingMap = {};
  existingData.forEach(row => {
    let table = row[0];
    let col = row[1];
    if (!existingMap[table]) existingMap[table] = {};
    existingMap[table][col] = row;
  });

  const finalRows = [];
  let addedCount = 0;
  
  // Sweep ALL sheets globally
  const sheets = ss.getSheets();
  sheets.forEach(sheet => {
    const tableName = sheet.getName();
    if (tableName === "Schema") return;
    
    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) return; // Skip entirely blank sheets
    
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    let dataRow = new Array(lastCol).fill("");
    if (sheet.getLastRow() >= 2) {
      dataRow = sheet.getRange(2, 1, 1, lastCol).getValues()[0];
    }
    
    headers.forEach((colName, i) => {
      if (!colName) return; 
      
      // If we already mapped this, keep its previous configuration and push to ordered array
      if (existingMap[tableName] && existingMap[tableName][colName]) {
        finalRows.push(existingMap[tableName][colName]);
        delete existingMap[tableName][colName]; 
      } else {
        // Discovery: We found an entirely new column missing from the active Schema!
        const cellData = dataRow[i];
        let impliedType = "STRING"; 
        
        if (cellData !== "") {
          if (Object.prototype.toString.call(cellData) === '[object Date]') impliedType = "TIMESTAMP";
          else if (typeof cellData === "number") impliedType = Number.isInteger(cellData) ? "INTEGER" : "FLOAT";
          else if (typeof cellData === "boolean") impliedType = "BOOLEAN";
        }
        
        if (colName === CONFIG.updated_at_header) impliedType = "TIMESTAMP";
        let isMandatory = (colName.includes("_id") || colName === "id");
        let isUnique = colName === "id";
        
        finalRows.push([tableName, colName, impliedType, "", isMandatory, isUnique]);
        addedCount++;
        
        // Ensure cache bust for this sheet so onEdit picks it up instantly
        CacheService.getScriptCache().remove("schema_" + tableName);
      }
    });

    // Output previously configured mappings that were later deleted from their sheets in a legacy block at the end of their group
    if (existingMap[tableName]) {
      Object.values(existingMap[tableName]).forEach(row => finalRows.push(row));
      delete existingMap[tableName];
    }
  });

  // Keep legacy entirely orphaned tables at the very bottom
  Object.values(existingMap).forEach(tableMap => {
    Object.values(tableMap).forEach(row => finalRows.push(row));
  });

  // Write dynamically merged sorting engine back to the sheet 
  if (finalRows.length > 0) {
    if (schemaSheet.getMaxRows() > 1) {
       schemaSheet.getRange(2, 1, schemaSheet.getMaxRows() - 1, 6).clearContent(); 
    }
    schemaSheet.getRange(2, 1, finalRows.length, 6).setValues(finalRows);
    
    // Inject Dropdowns gracefully down the full column range
    const typeRule = SpreadsheetApp.newDataValidation().requireValueInList(['INTEGER', 'FLOAT', 'STRING', 'TIMESTAMP'], true).build();
    schemaSheet.getRange(2, 3, finalRows.length, 1).setDataValidation(typeRule);
    
    const boolRule = SpreadsheetApp.newDataValidation().requireValueInList(['TRUE', 'FALSE'], true).build();
    schemaSheet.getRange(2, 5, finalRows.length, 2).setDataValidation(boolRule);
  }

  // Final Output Alert
  if (addedCount > 0) {
    SpreadsheetApp.getUi().alert(`Schema Processed Dynamically across all sheets.\nWe cleanly appended ${addedCount} new column mappings!`);
  } else {
    SpreadsheetApp.getUi().alert(`Schema fully optimized. No unmapped headers were detected across all tables.`);
  }
}
