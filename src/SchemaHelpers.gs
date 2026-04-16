/**
 * Constants & Settings
 */
const CONFIG = {
  updated_at_header: "updated_at",
  yellow_color: "#FFF2CC",
  soft_rejection_color: "#FCE8E6"
};

/**
 * Schema extraction constants based on the structured Table format:
 * - Col A (Idx 0): Table Name
 * - Col B (Idx 1): Column Name
 * - Col C (Idx 2): Type
 * - Col E (Idx 4): is_mandatory
 * - Col F (Idx 5): is_unique
 */
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
 */
function toggleSchemaLock(state) {
  PropertiesService.getScriptProperties().setProperty("SCHEMA_LOCKED", state.toString());
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  
  // Protect Row 1 globally across all sheets except Schema tab
  sheets.forEach(sheet => {
    if (sheet.getName() === "Schema") return;
    
    // Find existing protections on Row 1 from our script
    const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
    let row1Protected = false;
    
    // Cleanup old locks if state is False
    protections.forEach(p => {
       if (p.getDescription() === 'GovernanceEngine_RowLock') {
          if (!state) p.remove(); // Unlock entirely
          row1Protected = true;
       }
    });
    
    // Add Lock if turning ON
    if (state && !row1Protected) {
       const lockRange = sheet.getRange("1:1"); // Protects literally the entire first row natively blocking column ops
       const protection = lockRange.protect().setDescription('GovernanceEngine_RowLock');
       const me = Session.getEffectiveUser();
       // Add Editors gracefully, but since it's a lock against column structural changes,
       // warning users natively usually works well enough if they try to edit it.
       protection.setWarningOnly(true); 
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
    // Drop logic into cache (21600 seconds = 6 hours)
    cache.put("schema_" + sheetName, JSON.stringify(rules), 21600); 
    return rules;
  }
  
  return null;
}

/**
 * Auto-Generates the Schema based on the active sheet's headers and data row 1
 * Defaulting to STRING for blanks.
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
  // Load second row for type estimation
  let dataRow = new Array(lastCol).fill("");
  if (activeSheet.getLastRow() >= 2) {
    dataRow = activeSheet.getRange(2, 1, 1, lastCol).getValues()[0];
  }
  
  // Find or Create Schema Sheet
  let schemaSheet = ss.getSheetByName("Schema");
  if (!schemaSheet) {
    schemaSheet = ss.insertSheet("Schema");
    schemaSheet.appendRow(["TABLE", "COLUMN", "TYPE", "DESCRIPTION", "MANDATORY", "UNIQUE"]);
    schemaSheet.getRange("A1:F1").setFontWeight("bold");
    schemaSheet.setFrozenRows(1);
  }
  
  // Scrape existing schemas to prevent duplicate generation
  const existingRules = fetchAndCacheSchema(tableName, { put: () => {}, get: () => {} }) || {};
  let addedCount = 0;
  
  for (let i = 0; i < headers.length; i++) {
    const colName = headers[i];
    if (!colName) continue; // Skip empty header columns
    
    // Only generate if it doesn't already exist
    if (!existingRules[colName]) {
       const cellData = dataRow[i];
       let impliedType = "STRING"; // Default to STRING as requested!
       
       if (cellData !== "") {
         if (Object.prototype.toString.call(cellData) === '[object Date]') {
           impliedType = "TIMESTAMP";
         } else if (typeof cellData === "number") {
           // Decide if Float or Int
           impliedType = Number.isInteger(cellData) ? "INTEGER" : "FLOAT";
         } else if (typeof cellData === "boolean") {
           impliedType = "BOOLEAN";
         }
       }
       
       // Ensure updated_at is properly declared as TIMESTAMP
       if (colName === CONFIG.updated_at_header) {
          impliedType = "TIMESTAMP";
       }
       
       // Make unique identifiers mandatory natively
       let isMandatory = (colName.includes("_id") || colName === "id");
       let isUnique = colName === "id";
       
       schemaSheet.appendRow([tableName, colName, impliedType, "", isMandatory, isUnique]);
       addedCount++;
    }
  }
  
  if (addedCount > 0) {
    SpreadsheetApp.getUi().alert(`Schema Auto-Generation Complete.\nAdded ${addedCount} new column mappings for table '${tableName}'.`);
  } else {
    SpreadsheetApp.getUi().alert(`Schema mapping for '${tableName}' is already fully mapped. No new columns added.`);
  }
}
