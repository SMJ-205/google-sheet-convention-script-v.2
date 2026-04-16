/**
 * Constants & Settings
 */
const CONFIG = {
  // Define standard target header for the nudge
  updated_at_header: "updated_at",
  yellow_color: "#FFF2CC",
  soft_rejection_color: "#FCE8E6"
};

/**
 * Schema extraction constants based on the Plan.md:
 * Reads up to Col F (Index 5).
 * - Col E (Idx 4): is_mandatory
 * - Col F (Idx 5): is_unique
 */
const SCHEMA_MAP = {
  TABLE: 0,       // Col A
  COLUMN: 1,      // Col B
  TYPE: 2,        // Col C
  MANDATORY: 4,   // Col E
  UNIQUE: 5       // Col F
};

/**
 * Returns the lock state of the schema constraint.
 * @returns {boolean} Whether schema structural changes are blocked.
 */
function isSchemaLocked() {
  return PropertiesService.getScriptProperties().getProperty("SCHEMA_LOCKED") === "true";
}

/**
 * Toggles the schema lock state.
 * @param {boolean} state 
 */
function toggleSchemaLock(state) {
  PropertiesService.getScriptProperties().setProperty("SCHEMA_LOCKED", state.toString());
  return state;
}

/**
 * Converts Column Index (1-based) to Letter(s) A, B, Z, AA, etc.
 */
function getColLtr(num) {
  let ltr = '';
  while (num > 0) {
    let mod = (num - 1) % 26;
    ltr = String.fromCharCode(65 + mod) + ltr;
    num = parseInt((num - mod) / 26);
  }
  return ltr;
}

/**
 * Ensures formatting rules are enforced for float and timestamp types during edit
 */
function standardizeFormat(value, typeStr) {
  if (value === "") return "";
  
  if (typeStr && typeStr.toUpperCase() === "FLOAT") {
    let parsed = parseFloat(value);
    if (!isNaN(parsed)) {
      // Force 2 decimal standardization
      return Number(parsed.toFixed(2));
    }
  } else if (typeStr && typeStr.toUpperCase() === "TIMESTAMP") {
    let d = new Date(value);
    // Returns absolute date formatted by Javascript for valid Strings.
    if (!isNaN(d.getTime())) {
      // Returns Date object giving AppScript/Sheet ability to render native format
      return d;
    }
  }
  return value;
}

/**
 * Fetches schema from the "Schema" mapping config sheet and loads it to cache.
 */
function fetchAndCacheSchema(sheetName, cache) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schemaSheet = ss.getSheetByName("Schema");
  if (!schemaSheet) return null; // No Schema definitions present at all
  
  const lastRow = schemaSheet.getLastRow();
  if (lastRow < 2) return null; // Just headers, no schema listed
  
  const data = schemaSheet.getRange(2, 1, lastRow - 1, 6).getValues();
  
  const rules = {};
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    
    // Process schemas for the specific sheet we are caching
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
