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

/**
 * Wrapper to call schema generation from menu
 */
function triggerGenerateSchema() {
  generateSchema();
}

/**
 * Instant Sanitization trigger - Auto runs on every edit
 * Only handles formats, does not block user flow with alerts.
 */
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();
  if (sheetName === "Schema") return; // Never sanitize the schema itself
  
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
  if (row === 1) return; // Don't sanitize header row

  // Revert changes on row 1 if locked? No, native protected ranges handle header lock now! 
  // Native protection means we don't need programmatic reverted changes.

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colName = headers[col - 1]; 
  
  if (schema[colName]) {
    const typeStr = schema[colName].type;
    const val = e.value;
    
    // Process formatting if valid input
    if (val !== undefined && val !== "" && typeof val === 'string') {
      const sanitized = standardizeLocales(val, typeStr);
      if (sanitized !== val) {
        e.range.setValue(sanitized);
      }
    }
  }
}

/**
 * Converts Indonesian floats and loose timestamp formats automatically
 */
function standardizeLocales(value, typeStr) {
  if (typeStr && typeStr.toUpperCase() === "FLOAT") {
    // Indonesian Locale: 1.000.000,50 -> Remove dots, replace comma with dot
    // Only attempt conversion if it looks like a number string with commas/dots
    if (/[0-9.,]+/.test(value)) {
      // If it contains both comma and dot, and comma is at the end: "1.000,50"
      // Replace dot with empty string, replace comma with dot
      let cleaned = value.replace(/\./g, '').replace(/,/g, '.');
      let parsed = parseFloat(cleaned);
      if (!isNaN(parsed)) {
        return Number(parsed.toFixed(2));
      }
    }
  } else if (typeStr && typeStr.toUpperCase() === "TIMESTAMP") {
    // Matches DD-MM-YYYY or DD/MM/YY formats
    const match = value.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
    if (match) {
      let day = match[1].padStart(2, '0');
      let month = match[2].padStart(2, '0');
      let year = match[3];
      if (year.length === 2) {
        year = "20" + year; // Assume 20XX for 2 digits
      }
      return `${year}-${month}-${day}`; // ISO format handles well in Sheets
    }
  }
  return value;
}

/**
 * Batch Validation Logic
 * Sweeps all rows where `updated_at` is empty, validates against schema.
 * Replaces the old `validateActiveRow`.
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
  
  // Extract all data per column for fast uniqueness checks
  const colDataIndexMap = {};
  for (let c = 0; c < headers.length; c++) {
    colDataIndexMap[headers[c]] = data.map(row => String(row[c]).toLowerCase());
  }
  
  const failedRows = [];
  const passedRows = [];
  
  // Loop through rows
  for (let r = 0; r < data.length; r++) {
    const rowRangeIdx = r + 2; // +1 for 0-index, +1 for Header array offset
    const rowData = data[r];
    const updatedAtStamp = rowData[updatedAtColIdx];
    
    // Check if the row completely empty
    const isEmptyData = rowData.every((val, index) => index === updatedAtColIdx || val === "" || val === null);
    if (isEmptyData) continue;
    
    // Only validate rows that haven't been stamped
    if (updatedAtStamp === "" || updatedAtStamp === null) {
      let rowValid = true;
      let errors = [];
      
      for (let c = 0; c < headers.length; c++) {
        const colName = headers[c];
        const cellValue = rowData[c];
        
        if (schema[colName]) {
          // Mandatory Check
          if (schema[colName].is_mandatory && (cellValue === "" || cellValue === null || cellValue === undefined)) {
             rowValid = false;
             errors.push(`Missing Mandatory Field: ${colName}`);
          }
          
          // Uniqueness Check
          if (schema[colName].is_unique && cellValue !== "") {
            // How many times does this occur in the whole column?
            const cellValStr = String(cellValue).toLowerCase();
            const colVals = colDataIndexMap[colName];
            
            let count = 0;
            for (let v of colVals) {
              if (v === cellValStr) count++;
            }
            if (count > 1) {
               rowValid = false;
               errors.push(`Duplicate Value: ${colName}='${cellValue}'`);
            }
          }
        }
      }
      
      if (rowValid) {
        passedRows.push(rowRangeIdx);
      } else {
        failedRows.push({ rowNumber: rowRangeIdx, errors: errors });
      }
    }
  }
  
  // Stamp Passed Rows
  if (passedRows.length > 0) {
    const timestamp = new Date();
    passedRows.forEach(rowNum => {
       sheet.getRange(rowNum, updatedAtColIdx + 1).setValue(timestamp);
       // Clear any leftover manual conditional formats (Optionally paint it white or clear)
       sheet.getRange(rowNum, 1, 1, lastCol).setBackground(null); 
    });
  }
  
  // Paint Failed Rows and Alert User Option B logic
  if (failedRows.length > 0) {
    failedRows.forEach(failure => {
       sheet.getRange(failure.rowNumber, 1, 1, lastCol).setBackground(CONFIG.soft_rejection_color);
    });
    
    // Construct Alert
    let msg = `Validation Finished.\n\nStamped ${passedRows.length} successful rows.\n\nEncountered Errors in ${failedRows.length} rows:\n`;
    const limit = Math.min(failedRows.length, 5); // Don't overflow the UI alert box
    for (let i = 0; i < limit; i++) {
       msg += `Row ${failedRows[i].rowNumber}: ${failedRows[i].errors.join(", ")}\n`;
    }
    if (failedRows.length > 5) msg += `...and ${failedRows.length - 5} more rows.`;
    
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
