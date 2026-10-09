// Report layout knowledge. Site names and the drug list are NOT kept here:
// they are entered by the user and stored only in their own browser (see
// settings.js), so nothing organisation-specific lives in this repository.

// Columns are located by reading the table's header row. Each entry maps a
// column role to the characters that identify its heading; the first match wins.
export const HEADER_KEYWORDS = [
  ['qty', /量/],
  ['count', /筆/],
  ['code', /碼|藥材/],
  ['name', /品|名/],
  ['item', /項|次/],
  ['remark', /備|註|注/],
];
export const REQUIRED_COLUMNS = { code: '藥材碼', name: '品名', qty: '數量' };

// The usual left-to-right layout. Used only to confirm a header row whose
// headings were partly unreadable; a table with a different column count must
// have all three required headings readable.
export const DEFAULT_LAYOUT = ['item', 'code', 'name', 'count', 'qty', 'remark'];

// Pages are rasterised at this resolution before OCR.
export const RENDER_DPI = 300;
