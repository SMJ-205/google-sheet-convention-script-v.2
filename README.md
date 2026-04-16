# Sovereign Data Governance Engine

A lightweight, robust Google Apps Script framework to enforce database-like rules (data types, mandatory fields, uniqueness constraints) securely inside a normal Google Spreadsheet.

## 🚀 Features
- **Visual Nudges:** Unverified, new rows highlight yellow until validated.
- **Dynamic Data Sanitization:** `onEdit` instantly corrects formatting (e.g., standardizing `FLOAT` to 2 decimals, formatting `TIMESTAMP`).
- **Sidebar UI & Locking:** Prevent unauthorized structural changes (column header renames) via a UI toggle.
- **Strict Validation Check:** Button-driven verification checks mandatory and unique constraints before stamping changes with an `updated_at` timestamp.

---

## 🛠 Setup & Installation

**1. Copy the Code into Apps Script:**
1. Open your Google Sheet.
2. Click **Extensions > Apps Script**.
3. Create three files matching the structural names in the `src` folder:
   - `Code.gs` (Script file)
   - `SchemaHelpers.gs` (Script file)
   - `Sidebar.html` (HTML file)
4. Copy and paste the contents from the `src/` folder of this repository into the corresponding files in the Apps Script editor.
5. Click **Save** and close the editor. Let the Google Sheet refresh.

**2. Create the Schema:**
Your spreadsheet needs a dedicated configuration tab named exactly **Schema**.
The engine reads this mapping to enforce rules on your other sheets.

The `Schema` tab structure must have these columns in order:
- **Col A (Table):** The exact name of the sheet (e.g., "Users").
- **Col B (Column):** The exact name of the column header (e.g., "email").
- **Col C (Type):** Expected data type (e.g., `STRING`, `FLOAT`, `TIMESTAMP`).
- **Col D (Misc):** Not strictly read right now, can be used for descriptions.
- **Col E (Mandatory):** `TRUE` or `FALSE` (Enforces null checks).
- **Col F (Unique):** `TRUE` or `FALSE` (Enforces column duplication logic).

*(Example Row: `Users` | `email` | `STRING` | | `TRUE` | `TRUE`)*

---

## 📖 How to Use the Engine

### 1. Register a Target Sheet
1. Open the sheet you want to track (e.g., "Users").
2. Ensure you have a column named **`updated_at`**.
3. Click the **Governance Engine** menu at the top of Google Sheets and select **Open Sidebar**.
4. In the sidebar, click **Register Current Sheet**.
   - *Result: Conditional formatting is injected. Any row missing an `updated_at` timestamp will now turn Light Yellow as a "visual nudge" to complete it.*

### 2. Enter and Validate Data
1. Start entering data. `FLOAT` and `TIMESTAMP` columns mapped in the `Schema` tab will automatically auto-format themselves as you type.
2. Once the row is filled out, click your mouse on any cell in that new row.
3. In the sidebar, click **Validate Active Row**.
   - **If Valid:** The engine writes the current timestamp into the `updated_at` column, meaning the visual nudge (yellow) disappears. Validated!
   - **If Invalid:** The engine drops a popup error listing what constraints failed (e.g., "Missing Mandatory Fields: email"). The timestamp does not apply.

### 3. Locking the Structure
If you want to restrict spreadsheet administrators from accidentally changing the column headers:
1. Open the **Governance Engine** Sidebar.
2. Toggle the **Lock Schema** switch to "Locked".
3. Test it: Any attempt to edit the row 1 header will instantly revert, popping up a block message. To make a structural "migration", unlock it first!
