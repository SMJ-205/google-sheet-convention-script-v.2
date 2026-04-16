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
 * Instant Sanitization trigger - Auto runs on every edit
 */
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();
  
  const cache = CacheService.getScriptCache();
  let schemaStr = cache.get("schema_" + sheetName);
  let schema = null;
  
  // Exit immediately if sheet isn't in cache, saving execution time
  if (!schemaStr) {
    schema = fetchAndCacheSchema(sheetName, cache);
    if (!schema) return; // Exit if no schema table found
  } else {
    schema = JSON.parse(schemaStr);
  }
  
  if (isSchemaLocked()) {
    // Lock Schema logic: If they are modifying Row 1 (Headers) but schema is locked, block it!
    if (e.range.getRow() === 1) {
      e.range.setValue(e.oldValue || ""); // Revert changes
      SpreadsheetApp.getUi().alert("Operation blocked. Unlock Schema in the Console to perform migrations.");
      return; // Stop execution
    }
  }

  // Handle data sanitization for Types and Formats
  const row = e.range.getRow();
  const col = e.range.getColumn();
  if (row === 1) return; // Don't sanitize header row

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colName = headers[col - 1]; // 0-indexed header array
  
  if (schema[colName]) {
    const typeStr = schema[colName].type;
    const val = e.value;
    
    // Process formatting if single cell changed
    if (val !== undefined && typeof val === 'string') {
      const sanitized = standardizeFormat(val, typeStr);
      if (sanitized !== val) {
        e.range.setValue(sanitized);
      }
    }
  }
}

/**
 * Applies the Visual Nudge to the active sheet
 * Called directly from the sidebar.
 */
function registerSheet() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const updatedAtColIdx = headers.indexOf(CONFIG.updated_at_header) + 1;
  
  if (updatedAtColIdx === 0) {
    SpreadsheetApp.getUi().alert(`Column '${CONFIG.updated_at_header}' not found. Please add an '${CONFIG.updated_at_header}' column to use the visual nudge.`);
    return;
  }
  
  const letter = getColLtr(updatedAtColIdx);
  const ruleFormula = `=$${letter}2=""`;
  const range = sheet.getRange(2, 1, sheet.getMaxRows() - 1, sheet.getMaxColumns());
  
  // Build and apply new formatting rule
  const rule = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(ruleFormula)
      .setBackground(CONFIG.yellow_color)
      .setRanges([range])
      .build();
      
  const rules = sheet.getConditionalFormatRules();
  // Filter out exact duplicate rules first (prevent stacking multiple yellow rules on same sheet)
  const filteredRules = rules.filter(r => r.getBooleanCondition()?.getCriteriaValues()[0] !== ruleFormula);
  filteredRules.push(rule);
  sheet.setConditionalFormatRules(filteredRules);
  
  SpreadsheetApp.getUi().alert("Sheet successfully registered. Visual nudge applied (Empty rows now highlight yellow).");
}

/**
 * Validate Active Row
 * Called directly from the Sidebar button.
 */
function validateActiveRow() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const rowIndex = sheet.getActiveCell().getRow();
  
  if (rowIndex === 1) {
    SpreadsheetApp.getUi().alert("Cannot validate the header row.");
    return false;
  }
  
  const sheetName = sheet.getName();
  const cache = CacheService.getScriptCache();
  let schema = null;
  let schemaStr = cache.get("schema_" + sheetName);
  
  if (!schemaStr) {
    schema = fetchAndCacheSchema(sheetName, cache);
  } else {
    schema = JSON.parse(schemaStr);
  }
  
  if (!schema) {
    SpreadsheetApp.getUi().alert("No schema definition found for this sheet.");
    return false;
  }
  
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const rowData = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
  
  let valid = true;
  const missingMandatory = [];
  const duplicateValues = [];
  
  for (let i = 0; i < headers.length; i++) {
    const colName = headers[i];
    const cellValue = rowData[i];
    
    if (schema[colName]) {
      // 1. Mandatory Check
      if (schema[colName].is_mandatory && (cellValue === "" || cellValue === null || cellValue === undefined)) {
        valid = false;
        missingMandatory.push(colName);
      }
      
      // 2. Uniqueness Check
      if (schema[colName].is_unique && cellValue !== "") {
        const colValues = sheet.getRange(2, i + 1, Math.max(1, sheet.getLastRow() - 1), 1).getValues().flat();
        let occurrenceCount = 0;
        
        for (const v of colValues) {
           if (v !== "" && String(v).toLowerCase() === String(cellValue).toLowerCase()) {
             occurrenceCount++;
           }
        }
        
        // Count > 1 means there's a duplicate in the row space
        if (occurrenceCount > 1) {
          valid = false;
          duplicateValues.push(colName);
        }
      }
    }
  }
  
  if (!valid) {
    let msg = "Validation Failed:\n\n";
    if (missingMandatory.length > 0) {
      msg += "Missing Mandatory Fields:\n- " + missingMandatory.join("\n- ") + "\n\n";
    }
    if (duplicateValues.length > 0) {
      msg += "Duplicate Values in Unique Fields:\n- " + duplicateValues.join("\n- ") + "\n\n";
    }
    // Hard Mode: Warning Alert (does not timestamp, so row stays yellow)
    SpreadsheetApp.getUi().alert(msg);
    return false;
  }
  
  // Validation Passed: Timestamp the updated moment to dismiss the Visual Nudge (turns off Yellow)
  const updatedAtColIdx = headers.indexOf(CONFIG.updated_at_header) + 1;
  if (updatedAtColIdx > 0) {
    sheet.getRange(rowIndex, updatedAtColIdx).setValue(new Date());
  }
  
  // Cleans up any soft rejection formats silently via default rule structure
  return true;
}

/**
 * Provide initial settings to Sidebar UI loading
 */
function getSidebarData() {
  return {
    locked: isSchemaLocked()
  };
}
