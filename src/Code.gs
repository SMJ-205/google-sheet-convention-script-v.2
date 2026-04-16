/**
 * @OnlyCurrentDoc
 */

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Governance Engine')
      .addItem('Open Sidebar', 'showSidebar')
      .addItem('Validate Current Inputs', 'validateInputs')
      .addItem('Generate / Update Schema', 'triggerGenerateSchema')
      .addToUi();
}

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
 * Handle Structural Changes (Installable Trigger)
 * Automatically invoked by Sheets when columns are inserted, removing them forcibly if unauthorized.
 */
function handleStructuralChange(e) {
  try {
    if (!isSchemaLocked()) return;
    const sheet = SpreadsheetApp.getActiveSheet();
    if (sheet.getName() === "Schema") return;

    if (e.changeType === 'INSERT_COLUMN') {
      const lastCol = sheet.getMaxColumns();
      const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
      
      let deleted = false;
      // Seek backwards and delete columns that have entirely blank headers ( newly inserted ones )
      for (let c = headers.length - 1; c >= 0; c--) {
        if (headers[c] === "") {
          sheet.deleteColumn(c + 1);
          deleted = true;
        }
      }
      SpreadsheetApp.getUi().alert("⛔ SCHEMA IS LOCKED\n\nInserting columns is forbidden! The unauthorized column was automatically deleted.");
    } else if (e.changeType === 'REMOVE_COLUMN') {
      SpreadsheetApp.getUi().alert("⛔ SCHEMA IS LOCKED\n\nDeleting columns is forbidden! Please press Undo (Ctrl+Z) immediately or risk corrupting your table.");
    }
  } catch(err) {}
}

/**
 * Instant Sanitization trigger - Auto runs on every edit
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sheet = e.range.getSheet();
    const sheetName = sheet.getName();
    
    // 1. Explicitly Block Header Edits if Locked with Hard Pop-Up
    if (e.range.getRow() === 1 && isSchemaLocked() && sheetName !== "Schema") {
      e.range.setValue(e.oldValue || ""); 
      SpreadsheetApp.getUi().alert("⛔ SCHEMA IS LOCKED\n\nColumn names cannot be edited or renamed natively. Please unlock the schema to modify structures.");
      return;
    }
    
    // 2. Cache-Bust if Schema Tab is explicitly edited manually
    if (sheetName === "Schema") {
      const editedTable = sheet.getRange(e.range.getRow(), 1).getValue(); 
      if (editedTable) {
        CacheService.getScriptCache().remove("schema_" + editedTable);
      }
      return; 
    }
    
    if (e.range.getNumRows() > 1 || e.range.getNumColumns() > 1) return;
    
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
    if (row === 1) return; 

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const colName = headers[col - 1]; 
    if (!colName) return;
    
    // Safety matching
    const safeColName = colName.toString().trim();
    
    if (schema[safeColName]) {
      const typeStr = schema[safeColName].type;
      const val = e.value !== undefined ? e.value : e.range.getValue(); 
      
      if (val !== undefined && val !== "") {
        const sanitized = standardizeLocales(val, typeStr);
        
        // Throw strict visual UI alerts on mismatch natively checking 
        if (sanitized === null) {
          e.range.setValue(e.oldValue !== undefined ? e.oldValue : ""); 
          SpreadsheetApp.getUi().alert(`⛔ DATA TYPE MISMATCH\n\nColumn '${safeColName}' strictly expects a ${typeStr}.\n\nThe input was rejected and undone.`);
        } 
        else if (String(sanitized) !== String(val)) {
          e.range.setValue(sanitized);
        }
      }
    }
  } catch(err) {
    // SpreadsheetApp.getUi().alert("Debug onEdit Error: " + err.message);
  }
}

/**
 * Standardizes Type Coercion. 
 * Strengthened to explicitly reject numbers masquerading natively as timestamps.
 */
function standardizeLocales(value, typeStr) {
  if (value === "") return "";
  
  if (typeStr && typeStr.toUpperCase() === "INTEGER") {
    let parsed = Number(value);
    if (!isNaN(parsed) && Number.isInteger(parsed)) return parsed;
    return null; 
  } 
  else if (typeStr && typeStr.toUpperCase() === "FLOAT") {
    if (typeof value === 'number') return value;
    let cleaned = String(value).replace(/\./g, '').replace(/,/g, '.');
    let parsed = parseFloat(cleaned);
    if (!isNaN(parsed)) return Number(parsed.toFixed(2));
    return null;
  } 
  else if (typeStr && typeStr.toUpperCase() === "TIMESTAMP") {
    if (Object.prototype.toString.call(value) === '[object Date]') return value;
    
    const strVal = String(value).trim();
    
    // Strict enforcement: Dates must resemble standard format blocks otherwise JS native Date parser creates gibberish
    const isDatePattern = /^(\d{1,4})[-\/](\d{1,2})[-\/](\d{1,4})(.*)?$/.test(strVal);
    if (isDatePattern) {
        const match = strVal.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
        if (match) {
          let day = match[1].padStart(2, '0');
          let month = match[2].padStart(2, '0');
          let year = match[3];
          if (year.length === 2) year = "20" + year;
          let dateObj = new Date(`${year}-${month}-${day}`);
          if (!isNaN(dateObj.getTime())) return dateObj;
        } else {
          let dateObj = new Date(strVal);
          if (!isNaN(dateObj.getTime())) return dateObj;
        }
    }
    
    return null; // Absolutely failed Timestamp validations natively
  }
  else if (typeStr && typeStr.toUpperCase() === "STRING") {
    return String(value);
  }
  
  return value;
}

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
    SpreadsheetApp.getUi().alert("No schema definition found for this sheet natively in the 'Schema' tab.");
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
    SpreadsheetApp.getUi().alert(`Column '${CONFIG.updated_at_header}' not found natively. Validation requires it.`);
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
        const safeName = colName ? colName.toString().trim() : "";
        let cellValue = rowData[c];
        
        if (schema[safeName]) {
          if (schema[safeName].is_mandatory && (cellValue === "" || cellValue === null || cellValue === undefined)) {
             rowValid = false;
             errors.push(`Missing Mandatory: ${safeName}`);
          }
          
          if (cellValue !== "" && cellValue !== null && cellValue !== undefined) {
             if (schema[safeName].is_unique) {
               const cellValStr = String(cellValue).toLowerCase();
               const colVals = colDataIndexMap[colName];
               
               let count = 0;
               for (let v of colVals) {
                 if (v === cellValStr) count++;
               }
               if (count > 1) {
                  rowValid = false;
                  errors.push(`Duplicate: ${safeName}='${cellValue}'`);
               }
             }
          }
        }
      }
      
      if (rowValid) passedRows.push(rowRangeIdx);
      else failedRows.push({ rowNumber: rowRangeIdx, errors: errors });
    }
  }
  
  if (passedRows.length > 0) {
    const timestamp = new Date();
    passedRows.forEach(rowNum => {
       sheet.getRange(rowNum, updatedAtColIdx + 1).setValue(timestamp);
       sheet.getRange(rowNum, 1, 1, lastCol).setBackground(null); 
    });
  }
  
  if (failedRows.length > 0) {
    failedRows.forEach(failure => {
       sheet.getRange(failure.rowNumber, 1, 1, lastCol).setBackground(CONFIG.soft_rejection_color);
    });
    
    let msg = `Validation Complete.\n\nStamped ${passedRows.length} successful rows.\n\nErrors inside ${failedRows.length} failed rows:\n`;
    const limit = Math.min(failedRows.length, 5); 
    for (let i = 0; i < limit; i++) {
       msg += `Row ${failedRows[i].rowNumber}: ${failedRows[i].errors.join(", ")}\n`;
    }
    if (failedRows.length > 5) msg += `...and ${failedRows.length - 5} more failed rows.`;
    
    SpreadsheetApp.getUi().alert(msg);
    return false;
  }
  
  if (passedRows.length === 0 && failedRows.length === 0) {
    SpreadsheetApp.getUi().alert("No fully unverified entries were discovered.");
  } else {
    SpreadsheetApp.getUi().alert(`Success: Validated and natively stamped ${passedRows.length} unique entries.`);
  }
  
  return true;
}

function getSidebarData() {
  return {
    locked: isSchemaLocked()
  };
}
