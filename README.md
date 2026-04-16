# Sheet Convention Script : Data Governance Engine (v2)

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

**Alternative: Quick Start Template**
If you want to skip manual installation, you can directly copy this pre-configured template which already has the Governance Engine code installed:
👉 [**Data Governance Engine Template**](https://docs.google.com/spreadsheets/d/1oNE3USgnBD-tW0QfLguTUBUhOtpSInzs0PnYqkguvok/edit?gid=1467061432#gid=1467061432)
*(Click `File > Make a copy` to save it to your own Google Drive)*

**Deploying to a New Spreadsheet (Manual Setup):**
1. Open your Google Sheet.
2. Click **Extensions > Apps Script**.
3. Create three files matching the names in the `src` folder:
   - `Code.gs` (Script file)
   - `SchemaHelpers.gs` (Script file)
   - `Sidebar.html` (HTML file)
4. Copy and paste the contents from the `src/` folder of this repository into the Apps Script editor.
5. Click **Save** and close the Apps Script tab.
6. Refresh your Google Sheet browser tab.
7. **CRITICAL FIRST STEP:** Go to the custom menu `Governance Engine -> ⚙ Initialize Triggers`. Google will ask for permission authorization. Click through the warnings to allow the script to run. This step securely wires the background protection triggers natively to your sheet.

---

## 📖 How to Use the Engine

### 1. Define the Schema (Two Options)
The engine reads an internal configuration tab exactly named **Schema** to enforce data tracking rules on your active sheets.

**Option A (Auto-Generate):**
1. Ensure your active data sheet has a title, column headers, and at least *one row* of dummy or real data.
2. Go to **Governance Engine > Generate / Update Schema**.
3. The engine automatically evaluates integers, floats, dates, and text, generating the `Schema` target tab for you. It will also automatically append an `updated_at` column if your table doesn't have one.

**Option B (Manual Definition):**
Create a `Schema` tab and structure it exactly as: `TABLE` | `COLUMN` | `TYPE` | `DESCRIPTION` | `MANDATORY` | `UNIQUE`

### 2. Enter and Process Data
1. Start typing data into your registered sheet. As you finish editing a cell, the `onEdit` sanitization seamlessly ensures your inputs match the defined data types (`FLOAT`, `INTEGER`, `TIMESTAMP`, etc). Invalid inputs are cleanly erased natively before they pollute the database.
2. Every valid row edit automatically stamps the `updated_at` column with the exact timestamp of modification.
3. To validate rows against your strict schema constraints (`UNIQUE` and `MANDATORY`), open the Sidebar and click **Validate Current Inputs** (or run it from the menu).
   - *The engine aggressively sweeps the entire sheet based on newly added unvalidated data.*
   - **Passed Rows:** Accepted and verified cleanly.
   - **Failed Rows:** The row will be painted with a red rejection color. A detailed, scrollable dialog widget will appear explaining exactly which row and column failed (e.g., "Row 5: The 'email' column is not unique").

### 3. Locking the Structure
To ensure colleagues don't accidentally or maliciously insert arbitrary columns and break external data integrations:
1. Open **Governance Engine > Open Sidebar**.
2. Toggle the **Lock Schema** switch to ON.
3. *Effect:* Row 1 (your headers) is dynamically protected utilizing Google Sheets native array protections. Simultaneously, background triggers actively watch the data grid.
4. *Aggressive Enforcement:* If any user attempts to right-click and "Insert Column", the Governance Engine detects the unauthorized injection, **blocks it, and automatically deletes the inserted column** immediately, issuing a center-screen pop-up warning. 

### 4. Diagnostics & Troubleshooting
If you duplicate the Google Sheet, or if you feel structural protection isn't firing correctly:
- Run **Governance Engine -> 🔍 Check Trigger Status**
- This displays the count and status of your background triggers. You should see `onChangeInstallable` and `onEditInstallable` active.
- If they are missing, simply run `⚙ Initialize Triggers` to clear dead triggers and bind fresh ones to your session.
