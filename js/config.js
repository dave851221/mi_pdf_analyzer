// Fixed layout of the report table. Site names and the drug list are NOT kept
// here: they are entered by the user and stored only in their own browser
// (see settings.js), so nothing organisation-specific lives in this repository.

// Table columns, left to right: item no. | code | product name | count | quantity | remark
export const COLUMN_COUNT = 6;
export const COLUMNS = { code: 1, name: 2, qty: 4 };

// Pages are rasterised at this resolution before OCR.
export const RENDER_DPI = 300;
