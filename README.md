# Sovereign Data Governance Engine (v2)

A lightweight, robust Google Apps Script framework to enforce database-like rules (data types, mandatory fields, uniqueness constraints) securely inside a normal Google Spreadsheet.

## 🚀 Features
- **Auto-Schema Generation:** Let the script automatically map out your table schema simply based on your first row of data.
- **Dynamic Data Sanitization:** `onEdit` instantly corrects formatting:
  - Standardizes Indonesian `FLOAT` values (e.g. `1.000.000,50` -> `1000000.50`).
  - Normalizes `TIMESTAMP` dates from variations like `DD-MM-YYYY` or `DD/MM/YY` directly to `YYYY-MM-DD`.
- **Global Schema Locking:** True native Google Sheet protection blocks unwanted column insertions or deletions natively via the interactive UI sidebar limit.
- **Batch Validation Sweeping:** With one click, aggressively sweeps **all** unstamped rows across the sheet. Passes them through the schema rules, stamps successful rows, and flags failures immediately.

---

## 🛠 Setup & Installation

**Copy the Code into Apps Script:**
1. Open your Google Sheet.
2. Click **Extensions > Apps Script**.
3. Create three files matching the names in the `src` folder:
   - `Code.gs` (Script file)
   - `SchemaHelpers.gs` (Script file)
   - `Sidebar.html` (HTML file)
4. Copy and paste the contents from the `src/` folder of this repository into the Apps Script editor.
5. Click **Save** and refresh your Google Sheet.

---

## 📖 How to Use the Engine

### 1. Define the Schema (Two Options)
The engine reads an internal configuration tab named exactly **Schema** to enforce tracking rules on your active sheets.

**Option A (Auto-Generate):**
1. Ensure your active sheet has a title, column headers, and at least *one row* of dummy/real data.
2. Go to **Governance Engine > Generate / Update Schema**.
3. The engine automatically evaluates integers, floats, dates, and text, generating the `Schema` target tab for you. 

**Option B (Manual Definition):**
Create a `Schema` tab and structure it exactly as: `TABLE` | `COLUMN` | `TYPE` | `DESCRIPTION` | `MANDATORY` | `UNIQUE`

---

### 2. Enter and Process Data
1. Start typing data into your registered sheet. As you finish editing a cell, the `onEdit` sanitization seamlessly maps currencies and date variables to standard formats.
2. To validate rows against your unbending schema (uniqueness and mandatory constraints), select **Governance Engine > Validate Current Inputs** (also available in the Sidebar).
   - *The engine scans the entire sheet for rows missing the `updated_at` tracker timestamp.*
   - **Passed Rows:** Receive a permanent timestamp, finalizing them.
   - **Failed Rows:** Are painted red (soft rejection color) and an aggregate window tells you exactly which row and column failed (e.g., "Duplicate Value: email").

### 3. Locking the Structure
To ensure colleagues don't insert arbitrary columns:
1. Open **Governance Engine > Open Sidebar**.
2. Toggle the **Lock Schema** switch.
3. *Effect:* Row 1 (your headers) is dynamically protected utilizing Google Sheets native protections. Because Google formulas forbid mutating a protected structural line, this natively guarantees nobody can insert or remove a column unless the lock is toggled OFF.
