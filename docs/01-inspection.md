# Phase 1: RYD-SO worksheet inspection

Inspected on 2026-10-16, **read-only**, by opening the workbook in the browser while signed in to the owner's Google account and exporting CSV/XLSX copies in memory (nothing written to disk, nothing in the sheet changed). No operational data is stored in this repository.

## Workbook
14 visible tabs: BPO Tracking, **RYD-SO** (gid 519433600), IR-SO, ITT-SO, TO DO LIST, MAT. SO, LT, DROPDOWN, STOCK, CT, STEEL USAGE, TRAVELLER, BS, ALL_ORDERS_LOG_CURRENT, plus two hidden tabs (Quote, METRICS DATA ENTRY). The workbook is ~15 MB, mostly ALL_ORDERS_LOG_CURRENT (named range up to row 77125).

## RYD-SO layout (verified)
- **77 columns (A..BY)**, header in **row 2**; row 1 is a helper numbering row; data from row 3. Frozen: 2 rows and 11 columns (A..K).
- Sheet grid is 1361 rows; **888 rows have a PART #** (the real records). Rows below that only contain pre-filled formulas.
- Statuses seen: `1. ANALYSIS` (20), `3.OPEN` (328), `4.CLOSE` (511), `5.HOLD` (26), blank (474, mostly empty formula rows).
- 15 hidden rows, no hidden columns, no autofilter, no sheet protection.
- Customers (9 distinct): RAYMOND, CAMCO MFG, GMP, CAMCO STOCK, STANDEX, TOYOTA, ...
- Full column-by-column mapping: [field-mapping.md](field-mapping.md).

## Formulas and calculated columns (18 columns)
Pure formula columns (never written by the app): C, D (progress bars = share of filled cells in G:BI and BK:BU), H (price lookup from `STOCK`), L, O, P (lookups from `STEEL USAGE`), R, S, T (required ft / lbs / bars), U (stock lookup), V (the `HYPERLINK` mailto "Send Email" template), AG, AH, AP, AU, AW, BQ, BU.
Observed exceptions that must be preserved:
- Some cells in otherwise manual columns hold formulas: AF (247 cells, e.g. `=275*7.53`), I (6), J (35, e.g. `=AM542+55`), AT (1). **The backend refuses to overwrite any cell that currently contains a formula**, and the UI marks these fields "formula".
- S has a long nested `IF` by BAR TYPE (RD, RD-AL, SQ, REC., FLAT, TUBING) with density constants; it stays in the sheet (one source of truth).
- Several calculated columns currently show `#VALUE!` (V in a few rows, BU in a few rows); the app displays them as-is.

## Validation rules in the sheet
| Column | Rule |
|---|---|
| B STATUS | list: 1.ANR, 2.RFS, 5.HOLD, 3.OPEN, 4.CLOSE, 1. ANALYSIS |
| N BAR TYPE | list: RD, TUBING, SQ, REC., FLAT, HEX, RD-AL |
| AK KANBAN/PO | list: KANBAN, PO |
| AL SO TYPE | list: REPAIR, ROUGH, STANDARD (data also contains `NEW`) |
| X, Z, AC, AI, AY–BD, BG, BH, BN, BS | list: YES / NO |
Conditional formatting: STATUS text HOLD/RFS/ANR colouring, non-zero highlight on AU and AW, 100% bars on C:D.

## Data quality findings (not "fixed", just recorded)
- **No unique record ID.** SO# (col K) is blank on 44 of 888 records and duplicated twice (`R24449`, `22527`). It is not safe as a key, so the app uses an added `RECORD ID` column.
- SO# is stored as a number in 701 cells and text in 143 (e.g. `R24449`). PART # is text for 505 cells and a number for 383. No leading-zero identifiers exist today, but the app preserves them.
- Date columns mix true dates with text (`8-Oct`, `req.form`, `rec.form`, `10/5`). Existing text is kept unless a user explicitly picks a date.
- Legacy values outside the dropdowns exist (`NEW` SO type; `yes`, `Yes`, `Stock`, `req. form` in QUOTE RECEIVED?; `KMARUL` champion typo; `5/26/2025` in a YES/NO column). The app shows them as "(existing)" and does not reject unchanged values.
- Duplicate header `PO #` appears twice (AS and BJ); the app labels them by column letter.
- Mixed units in text-like numeric columns (`107.5 LBS` in QTY. IN STOCKROOM, `3/12` in HOW MANY FOLLOWUPS).

## Not verified / needs your answer
- Which other tabs (IR-SO, ITT-SO, MAT. SO ...) should be in scope. Only RYD-SO is implemented.
- Whether SO# is meant to be unique per row (two duplicates exist).
- Which fields each team member should be allowed to edit; currently every non-calculated field is editable by "editors".
- Spreadsheet time zone (affects how dates are written; the backend uses the spreadsheet's own zone).
- Whether the 15 hidden rows are intentionally hidden; the app currently shows them.
