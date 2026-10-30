// 无依赖 xlsx 产生器（支援字体大小、粗体、颜色、框线、对齐、換行、欄寬列高、凍结窗格）
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    chunks.push(local, data);
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (n) => {
  let s = '';
  n += 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

// ── 预设样式表 ──
// 语意化命名，让呼叫端只描述「这格是什么」，不碰样式编号
export const STYLES = {
  default: {},
  title: { size: 15, bold: true, color: '1F3864', align: 'left', valign: 'center' },
  subtitle: { size: 10, color: '6B7280', align: 'left', valign: 'center' },
  gameName: { size: 13, bold: true, color: 'FFFFFF', fill: '2F5597', align: 'left', valign: 'center', pad: true },
  sumLabel: { size: 11, bold: true, color: '1F3864', fill: 'D9E2F3', align: 'left', valign: 'center', border: true },
  sumValue: { size: 14, bold: true, color: 'C00000', fill: 'D9E2F3', align: 'center', valign: 'center', border: true },
  // 总客诉量的数字现在放在第三格（较宽的栏），靠左才跟左边的标签连成一句
  sumValueLeft: { size: 14, bold: true, color: 'C00000', fill: 'D9E2F3', align: 'left', valign: 'center', border: true },
  sumNote: { size: 10, color: '595959', fill: 'D9E2F3', align: 'left', valign: 'center', border: true },
  catName: { size: 11, bold: true, color: '1F3864', align: 'left', valign: 'center', border: true },
  catValue: { size: 12, bold: true, color: '000000', align: 'center', valign: 'center', border: true, fill: 'F2F2F2' },
  detail: { size: 10, color: '404040', align: 'left', valign: 'top', wrap: true, border: true },
  // 二级标签名称（比一级轻一点，缩排表示层级）
  subCatName: { size: 10, color: '404040', align: 'left', valign: 'center', border: true, pad: true },
  subCatValue: { size: 11, bold: true, color: '2F5597', align: 'center', valign: 'center', border: true },
  // 「具体内容」摘要
  summary: { size: 10, color: '333333', align: 'left', valign: 'center', wrap: true, border: true },
  tableHeader: { size: 11, bold: true, color: 'FFFFFF', fill: '4472C4', align: 'center', valign: 'center', border: true },
  tableText: { size: 10, color: '262626', align: 'left', valign: 'center', border: true },
  tableNum: { size: 10, color: '262626', align: 'center', valign: 'center', border: true },
  totalRow: { size: 11, bold: true, color: '1F3864', fill: 'FFF2CC', align: 'center', valign: 'center', border: true },
  totalRowLabel: { size: 11, bold: true, color: '1F3864', fill: 'FFF2CC', align: 'left', valign: 'center', border: true },
  spacer: { size: 6 },
};

function buildStyleTable(names) {
  const fonts = [{ size: 11, color: '000000', bold: false }];
  const fills = [{ rgb: null }, { rgb: null }]; // 0=none 1=gray125（xlsx 慣例）
  const borders = [{ all: false }];
  const xfs = [{ font: 0, fill: 0, border: 0, align: null, wrap: false }];

  const fontIndex = new Map([['11|000000|false', 0]]);
  const fillIndex = new Map();
  const borderIndex = new Map([['none', 0]]);

  const named = {};
  for (const name of names) {
    const s = STYLES[name] || {};
    if (name === 'default') {
      named[name] = 0;
      continue;
    }
    const size = s.size ?? 11;
    const color = s.color ?? '000000';
    const bold = !!s.bold;
    const fkey = `${size}|${color}|${bold}`;
    if (!fontIndex.has(fkey)) {
      fontIndex.set(fkey, fonts.length);
      fonts.push({ size, color, bold });
    }
    const fi = fontIndex.get(fkey);

    let bi = 0;
    if (s.fill) {
      if (!fillIndex.has(s.fill)) {
        fillIndex.set(s.fill, fills.length);
        fills.push({ rgb: s.fill });
      }
      bi = fillIndex.get(s.fill);
    }

    let boi = 0;
    if (s.border) {
      const key = 'thin';
      if (!borderIndex.has(key)) {
        borderIndex.set(key, borders.length);
        borders.push({ all: true });
      }
      boi = borderIndex.get(key);
    }

    const xf = { font: fi, fill: bi, border: boi, align: s.align ?? null, valign: s.valign ?? null, wrap: !!s.wrap, pad: !!s.pad };
    const xkey = JSON.stringify(xf);
    let xfi = xfs.findIndex((x) => JSON.stringify(x) === xkey);
    if (xfi < 0) {
      xfs.push(xf);
      xfi = xfs.length - 1;
    }
    named[name] = xfi;
  }
  return { named, fonts, fills, borders, xfs };
}

/**
 * @param {Array<Array<{v:any,s?:string}|any>>} grid  每格可为纯值，或 {v, s}（s 为 STYLES 名称）
 * @param {object} opts  sheetName, colWidths, rowHeights{index:height}, freezeRows, merges[[r1,c1,r2,c2]]
 */
export function buildXlsx(grid, opts = {}) {
  const { sheetName = 'Sheet1', colWidths = [], rowHeights = {}, freezeRows = 0, merges = [] } = opts;

  const usedStyles = new Set();
  for (const row of grid) for (const cell of row) {
    const s = cell && typeof cell === 'object' && !Array.isArray(cell) && 'v' in cell ? cell.s : null;
    usedStyles.add(s || 'default');
  }
  usedStyles.add('default');
  const { named, fonts, fills, borders, xfs } = buildStyleTable([...usedStyles]);

  const maxCols = grid.reduce((a, r) => Math.max(a, r.length), 0);
  const rowsXml = grid
    .map((row, ri) => {
      const cells = row
        .map((cell, ci) => {
          const isObj = cell && typeof cell === 'object' && !Array.isArray(cell) && 'v' in cell;
          const v = isObj ? cell.v : cell;
          const sName = isObj ? cell.s : null;
          const sIdx = sName ? named[sName] ?? 0 : 0;
          const ref = `${colName(ci)}${ri + 1}`;
          const sAttr = sIdx ? ` s="${sIdx}"` : '';
          if (v === null || v === undefined || v === '') return `<c r="${ref}"${sAttr}/>`;
          if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
          return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        })
        .join('');
      const h = rowHeights[ri] ? ` ht="${rowHeights[ri]}" customHeight="1"` : '';
      const firstCol = row.length ? colName(0) : 'A';
      return `<row r="${ri + 1}"${h}>${cells}</row>`;
    })
    .join('');

  const colsXml = colWidths.length
    ? `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';

  const paneXml = freezeRows
    ? `<pane ySplit="${freezeRows}" topLeftCell="A${freezeRows + 1}" activePane="bottomLeft" state="frozen"/>`
    : '';

  const mergesXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map(([r1, c1, r2, c2]) => `<mergeCell ref="${colName(c1)}${r1 + 1}:${colName(c2)}${r2 + 1}"/>`).join('')}</mergeCells>`
    : '';

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">${paneXml}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="16"/>${colsXml}<sheetData>${rowsXml}</sheetData>${mergesXml}</worksheet>`;

  const fontsXml = `<fonts count="${fonts.length}">${fonts
    .map((f) => `<font>${f.bold ? '<b/>' : ''}<sz val="${f.size}"/><color rgb="FF${f.color}"/><name val="Microsoft JhengHei"/></font>`)
    .join('')}</fonts>`;

  const fillsXml = `<fills count="${fills.length}">${fills
    .map((f, i) =>
      i === 0
        ? '<fill><patternFill patternType="none"/></fill>'
        : i === 1
          ? '<fill><patternFill patternType="gray125"/></fill>'
          : `<fill><patternFill patternType="solid"><fgColor rgb="FF${f.rgb}"/><bgColor indexed="64"/></patternFill></fill>`,
    )
    .join('')}</fills>`;

  const thin = '<color rgb="FFBFBFBF"/><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/>';
  const bordersXml = `<borders count="${borders.length}">${borders
    .map((b) => (b.all ? `<border>${thin}</border>` : '<border><left/><right/><top/><bottom/><diagonal/></border>'))
    .join('')}</borders>`;

  const xfsXml = `<cellXfs count="${xfs.length}">${xfs
    .map((x) => {
      const al = [];
      if (x.align) al.push(`horizontal="${x.align}"`);
      if (x.valign) al.push(`vertical="${x.valign}"`);
      if (x.wrap) al.push('wrapText="1"');
      al.push(`indent="${x.pad ? 1 : 0}"`);
      const applyAl = x.align || x.valign || x.wrap || x.pad ? ' applyAlignment="1"' : '';
      return `<xf numFmtId="0" fontId="${x.font}" fillId="${x.fill}" borderId="${x.border}" xfId="0" applyFont="1" applyFill="1" applyBorder="1"${applyAl}><alignment ${al.join(' ')}/></xf>`;
    })
    .join('')}</cellXfs>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${fontsXml}${fillsXml}${bordersXml}<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>${xfsXml}<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  return makeZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>weekly-report-tool</dc:creator></cp:coreProperties>` },
  ]);
}

export async function writeXlsx(file, grid, opts = {}) {
  const buf = buildXlsx(grid, opts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, buf);
    return { bytes: buf.length, file };
  } catch (e) {
    // 档案被 Excel 开著而锁定时，改用带时间戳的档名，不让整个流程失敗
    if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')) {
      const dir = path.dirname(file);
      const ext = path.extname(file);
      const base = path.basename(file, ext);
      const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
      const alt = path.join(dir, `${base}_${stamp}${ext}`);
      await fs.writeFile(alt, buf);
      return { bytes: buf.length, file: alt, lockedFrom: file };
    }
    throw e;
  }
}
