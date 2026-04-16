/**
 * @OnlyCurrentDoc
 */

/**
 * Creates menu on open
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Governance Engine')
      .addItem('Open Sidebar', 'showSidebar')
      .addItem('Validate Current Inputs', 'validateInputs')
      .addItem('Generate / Update Schema', 'triggerGenerateSchema')
      .addToUi();
}

/**
 * Serve Sidebar HTML
 */
function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
      .setTitle('Data Governance Engine')
      .setWidth(300);
  SpreadsheetApp.getUi().showSidebar(html);
}

function triggerGenerateSchema() {
  generateSchema();
}

/**
 * Instant Sanitization trigger - Auto runs on every edit
 * Blocks invalid structure changes and invalid data types on the spot.
 */
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();
  
  // 1. Explicitly Block Header Edits if Locked (Covers the Owner fallback)
  if (e.range.getRow() === 1 && isSchemaLocked() && sheetName !== "Schema") {
    e.range.setValue(e.oldValue || ""); // Undo immediately
    SpreadsheetApp.getUi().alert("Schema is LOCKED! Column names cannot be edited or tampered with. Please unlock to modify structure.");
    return;
  }
  
  if (sheetName === "Schema") return; 
  
  const cache = CacheService.getScriptCache();
  let schemaStr = cache.get("schema_" + sheetName);
  let schema = null;
  
  if (!schemaStr) {
    schema = fetchAndCacheSchema(sheetName, cache);
    if (!schema) return; 
  } else {
    schema = JSON.parse(schemaStr);
  }

  const row = e.range.getRow();
  const col = e.range.getColumn();
  if (row === 1) return; // Handled above

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colName = headers[col - 1]; 
  
  if (schema[colName]) {
    const typeStr = schema[colName].type;
    const val = e.value !== undefined ? e.value : e.range.getValue(); 
    
    if (val !== undefined && val !== "") {
      const sanitized = standardizeLocales(val, typeStr);
      
      // Null signals a complete parsing failure (Type Mismatch)
      if (sanitized === null) {
        e.range.setValue(e.oldValue || ""); // Revert input natively
        SpreadsheetApp.getActive().toast(`Type Mismatch: Column '${colName}' expects ${typeStr}. Change reverted.`, 'Governance Engine', 5);
      } 
      // Successful type coercion -> overwrite the raw input with standardized form
      else if (String(sanitized) !== String(val)) {
        e.range.setValue(sanitized);
      }
    }
  }
}

/**
 * Standardizes Type Coercion. 
 * Returns NULL if the value is completely incompatible with the required type.
 */
function standardizeLocales(value, typeStr) {
  if (value === "") return "";
  
  if (typeStr && typeStr.toUpperCase() === "INTEGER") {
    let parsed = Number(value);
    if (!isNaN(parsed) && Number.isInteger(parsed)) return parsed;
    return null; // Force null on failure
  } 
  else if (typeStr && typeStr.toUpperCase() === "FLOAT") {
    if (typeof value === 'number') return value;
    // Handle Indonesian localization (dots as thousand separators, comma as decimal)
    let cleaned = String(value).replace(/\./g, '').replace(/,/g, '.');
    let parsed = parseFloat(cleaned);
    if (!isNaN(parsed)) return Number(parsed.toFixed(2));
    return null;
  } 
  else if (typeStr && typeStr.toUpperCase() === "TIMESTAMP") {
    if (Object.prototype.toString.call(value) === '[object Date]') return value;
    
    // Check custom DD/MM/YYYY
    const match = String(value).match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
    if (match) {
      let day = match[1].padStart(2, '0');
      let month = match[2].padStart(2, '0');
      let year = match[3];
      if (year.length === 2) year = "20" + year;
      let dateObj = new Date(`${year}-${month}-${day}`);
      if (!isNaN(dateObj.getTime())) return dateObj;
    }
    
    // Fallback to JS Date evaluation
    let dateObj = new Date(value);
    if (!isNaN(dateObj.getTime())) return dateObj;
    
    return null; // Invalid Date String
  }
  else if (typeStr && typeStr.toUpperCase() === "STRING") {
    return String(value);
  }
  
  return value;
}

/**
 * Batch Validation Logic
 * Sweeps all rows where `updated_at` is empty, validates against schema.
 */
function validateInputs() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const sheetName = sheet.getName();
  if (sheetName === "Schema") {
    SpreadsheetApp.getUi().alert("Cannot run validation on the Schema sheet.");
    return false;
  }
  
  const cache = CacheService.getScriptCache();
  let schemaStr = cache.get("schema_" + sheetName);
  let schema = null;
  
  if (!schemaStr) {
    schema = fetchAndCacheSchema(sheetName, cache);
  } else {
    schema = JSON.parse(schemaStr);
  }
  
  if (!schema) {
    SpreadsheetApp.getUi().alert("No schema definition found for this sheet in the 'Schema' tab.");
    return false;
  }
  
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert("No data available to validate.");
    return true;
  }
  
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const updatedAtColIdx = headers.indexOf(CONFIG.updated_at_header);
  
  if (updatedAtColIdx === -1) {
    SpreadsheetApp.getUi().alert(`Column '${CONFIG.updated_at_header}' not found. Validation requires this column.`);
    return false;
  }
  
  const colDataIndexMap = {};
  for (let c = 0; c < headers.length; c++) {
    colDataIndexMap[headers[c]] = data.map(row => String(row[c]).toLowerCase());
  }
  
  const failedRows = [];
  const passedRows = [];
  
  for (let r = 0; r < data.length; r++) {
    const rowRangeIdx = r + 2; 
    const rowData = data[r];
    const updatedAtStamp = rowData[updatedAtColIdx];
    
    const isEmptyData = rowData.every((val, index) => index === updatedAtColIdx || val === "" || val === null);
    if (isEmptyData) continue;
    
    if (updatedAtStamp === "" || updatedAtStamp === null) {
      let rowValid = true;
      let errors = [];
      
      for (let c = 0; c < headers.length; c++) {
        const colName = headers[c];
        let cellValue = rowData[c];
        
        if (schema[colName]) {
          // 1. Mandatory Check
          if (schema[colName].is_mandatory && (cellValue === "" || cellValue === null || cellValue === undefined)) {
             rowValid = false;
             errors.push(`Missing Mandatory: ${colName}`);
          }
          
          if (cellValue !== "" && cellValue !== null && cellValue !== undefined) {
             // 2. Type Checking
             const validFormat = standardizeLocales(cellValue, schema[colName].type);
             if (validFormat === null) {
                rowValid = false;
                errors.push(`Invalid Type: ${colName} expects ${schema[colName].type}`);
             }
            
             // 3. Uniqueness Check
             if (schema[colName].is_unique) {
               const cellValStr = String(cellValue).toLowerCase();
               const colVals = colDataIndexMap[colName];
               
               let count = 0;
               for (let v of colVals) {
                 if (v === cellValStr) count++;
               }
               if (count > 1) {
                  rowValid = false;
                  errors.push(`Duplicate: ${colName}='${cellValue}'`);
               }
             }
          }
        }
      }
      
      if (rowValid) passedRows.push(rowRangeIdx);
      else failedRows.push({ rowNumber: rowRangeIdx, errors: errors });
    }
  }
  
  // Stamp Passed Rows
  if (passedRows.length > 0) {
    const timestamp = new Date();
    passedRows.forEach(rowNum => {
       sheet.getRange(rowNum, updatedAtColIdx + 1).setValue(timestamp);
       sheet.getRange(rowNum, 1, 1, lastCol).setBackground(null); 
    });
  }
  
  // Alert Error Reporting
  if (failedRows.length > 0) {
    failedRows.forEach(failure => {
       sheet.getRange(failure.rowNumber, 1, 1, lastCol).setBackground(CONFIG.soft_rejection_color);
    });
    
    let msg = `Validation Complete.\n\nStamped ${passedRows.length} successful rows.\n\nErrors inside ${failedRows.length} rows:\n`;
    const limit = Math.min(failedRows.length, 5); 
    for (let i = 0; i < limit; i++) {
       msg += `Row ${failedRows[i].rowNumber}: ${failedRows[i].errors.join(", ")}\n`;
    }
    if (failedRows.length > 5) msg += `...and ${failedRows.length - 5} more failed rows.`;
    
    SpreadsheetApp.getUi().alert(msg);
    return false;
  }
  
  if (passedRows.length === 0 && failedRows.length === 0) {
    SpreadsheetApp.getUi().alert("No new unstamped entries found to validate.");
  } else {
    SpreadsheetApp.getUi().alert(`Success: Validated and stamped ${passedRows.length} entries.`);
  }
  
  return true;
}

/**
 * Handlers for sidebar HTML
 */
function getSidebarData() {
  return {
    locked: isSchemaLocked()
  };
}
