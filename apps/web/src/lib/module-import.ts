import type { ModuleCollection } from './modules';

export function parseModuleCsv(text: string): { headers: string[]; rows: string[][] } {
  if (text.length > 2_000_000) throw new Error('Choose a CSV file smaller than 2 MB.');
  text = text.replace(/^\uFEFF/, '');
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false, closed = false;
  for (let index = 0; index <= text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === undefined) throw new Error('A quoted CSV value is not closed.');
      if (char === '"') { if (text[index + 1] === '"') { value += '"'; index++; } else { quoted = false; closed = true; } }
      else value += char;
      continue;
    }
    if (char === '"' && !value && !closed) { quoted = true; continue; }
    if (char === ',' || char === '\n' || char === '\r' || char === undefined) {
      row.push(value); value = ''; closed = false;
      if (char !== ',') { if (row.some((cell) => cell.trim())) rows.push(row); row = []; if (char === '\r' && text[index + 1] === '\n') index++; }
      if (rows.length > 101) throw new Error('Import up to 100 data rows at a time. Split this file into smaller batches.');
      continue;
    }
    if (closed || char === '"') throw new Error('Unexpected text beside a CSV quote. Quote the entire value.');
    value += char;
  }
  const headers = rows.shift();
  if (!headers || !headers.length || headers.length > 100 || !rows.length) throw new Error('Include a header and 1–100 data rows, with at most 100 columns.');
  if (rows.some((cells) => cells.length !== headers.length)) throw new Error('Each CSV row must have the same number of columns as the header.');
  return { headers, rows };
}

export function mapModuleImportRows(collection: ModuleCollection, mapping: string[], rows: string[][]) {
  const used = mapping.filter(Boolean);
  if (!used.length) throw new Error('Map at least one column.');
  if (new Set(used).size !== used.length) throw new Error('Map each destination field only once.');
  return rows.map((cells, rowIndex) => Object.fromEntries(mapping.flatMap((key, index) => {
    if (!key || !cells[index]?.trim()) return [];
    const field = collection.fields.find((item) => item.key === key);
    if (!field || ['relation', 'resource_ref', 'member'].includes(field.type)) throw new Error('Choose a supported destination field.');
    const raw = cells[index]!.trim(); let value: unknown = raw;
    if (field.type === 'number') { value = Number(raw); if (!Number.isFinite(value)) throw new Error(`Row ${rowIndex + 1}: ${field.label} needs a number.`); }
    if (field.type === 'boolean') {
      if (!/^(true|false|yes|no|1|0)$/i.test(raw)) throw new Error(`Row ${rowIndex + 1}: ${field.label} needs true/false or yes/no.`);
      value = /^(true|yes|1)$/i.test(raw);
    }
    if (field.type === 'single_select') value = field.options.find((option) => option.value.toLowerCase() === raw.toLowerCase() || option.label.toLowerCase() === raw.toLowerCase())?.value ?? raw;
    if (field.type === 'tags') value = [...new Set(raw.split(';').map((item) => item.trim()).filter(Boolean))];
    if (field.type === 'multi_select') value = raw.split(';').map((item) => item.trim()).filter(Boolean).map((item) => field.options.find((option) => option.value.toLowerCase() === item.toLowerCase() || option.label.toLowerCase() === item.toLowerCase())?.value ?? item);
    return [[key, value]];
  })));
}
