
## **Final Project Specification: Sovereign Data Governance Engine**

### **1. Evolution Matrix**

| Feature              | Current State            | Improved State (Final)                                    |
| :------------------- | :----------------------- | :-------------------------------------------------------- |
| **Trigger Logic**    | Raw `onEdit` (Slow)      | `onEdit` + **CacheService** for $O(1)$ lookup.            |
| **Validation Layer** | Post-entry Script only   | **Hybrid:** Native Validation + Script Sanitization.      |
| **Error Handling**   | `clearContent()` + Alert | **Toggle:** Hard Delete (Warning) vs. Soft Rejection.     |
| **Setup Process**    | Manual entry             | **Sidebar UI** with auto-header protection.               |
| **Integrity**        | Type checking only       | Enforces **is_mandatory** and **is_unique**.              |
| **Migrations**       | Manual updates           | **Auto-Sync:** Renaming Schema renames Data headers.      |
| **Security**         | Open                     | **Lock Schema Toggle:** Blocks structural changes.        |
| **Visuals**          | None                     | **Nudge System:** Unverified rows are highlighted yellow. |

---

### **2. Security: The Lock Schema Toggle**

The Sidebar UI will include a master toggle stored in `PropertiesService` (`SCHEMA_LOCKED`).

- **Protocol:** Before the Sidebar executes a field rename or adds a new column, it verifies the lock state.
- **Hard Stop:** If `true`, the UI prevents the action and alerts the user: _"Operation blocked. Unlock Schema in the Console to perform migrations."_

---

### **3. UI & Feedback: The "Visual Nudge"**

When a sheet is registered, a programmatic **Conditional Formatting** rule is injected:

- **Rule:** `=$[UpdatedAtColumn]2=""`
- **Visual:** Fills the entire row with **Light Yellow**.
- **Result:** As soon as the user clicks "Validate Row" and the check passes, the timestamp is added, and the yellow highlight vanishes. It’s a silent, visual "to-do" list.

---

### **4. Validation & Error Handling (Hard Mode + Mandatory)**

Based on your preference for **Warning** behavior:

- **Mandatory Field Check:** If a user clicks "Validate Row" and a field marked `is_mandatory` is empty:
  1.  The script triggers a `SpreadsheetApp.getUi().alert()`.
  2.  The alert lists exactly which columns are missing data.
  3.  **The row remains yellow.**
  4.  The `updated_at` timestamp **remains frozen**.
  5.  The data is only "stamped" once the user fills the field and re-runs the validation.

---

### **5. Technical Logic Flow**

#### **A. Instant Sanitization (`onEdit`)**

- Handles **Types** and **Formats** only (Standardizing `FLOAT` decimals and `TIMESTAMP` strings).
- Exits immediately if the sheet isn't in the Cache to save performance.

#### **B. Logical Verification (Sidebar Button)**

- **Uniqueness:** Scans the column for duplicates.
- **Mandatory:** Checks for nulls/empty strings.
- **Execution:**
  - **If Valid:** Clears any "Soft Rejection" formatting, sets the `updated_at` to the **moment of the fix**, and clears the "Nudge" highlight.
  - **If Invalid:** \* **Hard Mode:** Pops the **Warning Alert**; keeps the timestamp frozen.
    - **Soft Mode:** Highlights specific cells red; keeps the timestamp frozen.

---

### **6. Implementation Note for Antigravity**

When generating the `validateActiveRow` function, ensure the script reads the **Schema** up to Column **F**.

> **Schema Mapping:** > \* **Column E:** `is_mandatory` (Boolean)
>
> - **Column F:** `is_unique` (Boolean)

This setup is now ready for deployment. It provides a rigorous, ETL-ready environment while remaining friendly enough for manual data entry.
