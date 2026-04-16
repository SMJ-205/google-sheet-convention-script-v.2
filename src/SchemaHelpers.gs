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

/**
 * Lock retrieval via properties
 */
function isSchemaLocked() {
  return PropertiesService.getScriptProperties().getProperty("SCHEMA_LOCKED") === "true";
}

/**
 * Advanced Lock Toggle: Natively protects sheets to physically prevent inserting columns
 * Now uses strict permissions logic instead of mere warnings.
 */
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
       
       // Strict lock: enforce maximum restrictions
       const me = Session.getEffectiveUser();
       protection.addEditor(me);
       protection.removeEditors(protection.getEditors());
       if (protection.canDomainEdit()) {
         protection.setDomainEdit(false);
       }
       // We DO NOT set warning only. We completely forbid editing to non-owners.
    }
  });

  return state;
}

/**
 * Fetches schema from the "Schema" mapping config sheet and loads it to cache.
 */
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
 * Auto-Generates the Schema based on the active sheet's headers and data row 1
 * Automatically binds Data Validation (Dropdowns) to the Schema table.
 */
function generateSchema() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet = ss.getActiveSheet();
  const tableName = activeSheet.getName();
  
  if (tableName === "Schema") {
    SpreadsheetApp.getUi().alert("Cannot auto-generate schema for the Schema sheet itself.");
    return;
  }
  
  const lastCol = activeSheet.getLastColumn();
  if (lastCol === 0) {
    SpreadsheetApp.getUi().alert("Active sheet has no headers. Please create headers first.");
    return;
  }
  
  const headers = activeSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  let dataRow = new Array(lastCol).fill("");
  if (activeSheet.getLastRow() >= 2) {
    dataRow = activeSheet.getRange(2, 1, 1, lastCol).getValues()[0];
  }
  
  let schemaSheet = ss.getSheetByName("Schema");
  if (!schemaSheet) {
    schemaSheet = ss.insertSheet("Schema");
    schemaSheet.appendRow(["TABLE", "COLUMN", "TYPE", "DESCRIPTION", "MANDATORY", "UNIQUE"]);
    schemaSheet.getRange("A1:F1").setFontWeight("bold");
    schemaSheet.setFrozenRows(1);
    
    // Inject Interactive Data Validation Dropdowns for TYPE, MANDATORY, UNIQUE
    const typeRule = SpreadsheetApp.newDataValidation().requireValueInList(['INTEGER', 'FLOAT', 'STRING', 'TIMESTAMP'], true).build();
    schemaSheet.getRange("C2:C").setDataValidation(typeRule);
    
    const boolRule = SpreadsheetApp.newDataValidation().requireValueInList(['TRUE', 'FALSE'], true).build();
    schemaSheet.getRange("E2:F").setDataValidation(boolRule);
  }
  
  const existingRules = fetchAndCacheSchema(tableName, { put: () => {}, get: () => {} }) || {};
  let addedCount = 0;
  
  for (let i = 0; i < headers.length; i++) {
    const colName = headers[i];
    if (!colName) continue; 
    
    if (!existingRules[colName]) {
       const cellData = dataRow[i];
       let impliedType = "STRING"; 
       
       if (cellData !== "") {
         if (Object.prototype.toString.call(cellData) === '[object Date]') {
           impliedType = "TIMESTAMP";
         } else if (typeof cellData === "number") {
           impliedType = Number.isInteger(cellData) ? "INTEGER" : "FLOAT";
         } else if (typeof cellData === "boolean") {
           impliedType = "BOOLEAN";
         }
       }
       
       if (colName === CONFIG.updated_at_header) {
          impliedType = "TIMESTAMP";
       }
       
       let isMandatory = (colName.includes("_id") || colName === "id");
       let isUnique = colName === "id";
       
       schemaSheet.appendRow([tableName, colName, impliedType, "", isMandatory, isUnique]);
       addedCount++;
    }
  }
  
  if (addedCount > 0) {
    SpreadsheetApp.getUi().alert(`Schema Auto-Generation Complete.\nAdded ${addedCount} new column mappings for table '${tableName}'.\n\nThe Schema tab now has interactive dropdowns for your rules!`);
  } else {
    SpreadsheetApp.getUi().alert(`Schema mapping for '${tableName}' is already fully mapped. No new columns added.`);
  }
}
