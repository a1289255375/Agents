// Text encodings and line endings. Files keep the encoding and line endings they already have,
// including the legacy Windows code pages (GBK on Chinese Windows) that Node cannot encode by itself.

export class TextError extends Error {}

const codePageLabels = new Map([
  [936, "gbk"], [950, "big5"], [932, "shift_jis"], [949, "euc-kr"], [874, "windows-874"], [866, "ibm866"],
  [1250, "windows-1250"], [1251, "windows-1251"], [1252, "windows-1252"], [1253, "windows-1253"],
  [1254, "windows-1254"], [1255, "windows-1255"], [1256, "windows-1256"], [1257, "windows-1257"], [1258, "windows-1258"],
]);
export const legacyEncodings = [...codePageLabels.values()];

export function encodingOfCodePage(codePage) {
  return codePageLabels.get(codePage);
}

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const utf16leBom = Buffer.from([0xff, 0xfe]);
const utf16beBom = Buffer.from([0xfe, 0xff]);
const strictDecoders = new Map();
const lenientDecoders = new Map();

function decoderOf(cache, label, options) {
  let decoder = cache.get(label);
  if (!decoder) cache.set(label, decoder = new TextDecoder(label, options));
  return decoder;
}

function strictDecode(label, bytes) {
  return decoderOf(strictDecoders, label, { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function decodeBuffer(buffer, legacyEncoding) {
  try {
    if (buffer.subarray(0, 3).equals(utf8Bom)) return { text: strictDecode("utf-8", buffer.subarray(3)), encoding: "utf8-bom" };
    if (buffer.subarray(0, 2).equals(utf16leBom)) return { text: strictDecode("utf-16le", buffer.subarray(2)), encoding: "utf16le" };
    if (buffer.subarray(0, 2).equals(utf16beBom)) return { text: strictDecode("utf-16be", buffer.subarray(2)), encoding: "utf16be" };
  } catch {
    throw new TextError("文件带有 BOM 但内容不是合法的 Unicode 文本");
  }
  if (buffer.includes(0)) throw new TextError("这是二进制文件，不能按文本处理");
  try {
    return { text: strictDecode("utf-8", buffer), encoding: "utf8" };
  } catch {}
  try {
    return { text: strictDecode(legacyEncoding, buffer), encoding: legacyEncoding };
  } catch {}
  throw new TextError(`无法识别文件编码（既不是 UTF-8 也不是 ${legacyEncoding}）`);
}

export function encodeText(text, encoding) {
  if (encoding === "utf8") return Buffer.from(text, "utf8");
  if (encoding === "utf8-bom") return Buffer.concat([utf8Bom, Buffer.from(text, "utf8")]);
  if (encoding === "utf16le") return Buffer.concat([utf16leBom, Buffer.from(text, "utf16le")]);
  if (encoding === "utf16be") return Buffer.concat([utf16beBom, Buffer.from(text, "utf16le").swap16()]);
  return encodeLegacy(text, encoding);
}

const legacyTables = new Map();

// Node only decodes legacy code pages. Decoding every one- and two-byte sequence once gives the reverse table.
function legacyTable(label) {
  let table = legacyTables.get(label);
  if (table) return table;
  table = new Map();
  const add = (bytes) => {
    let text;
    try { text = strictDecode(label, bytes); } catch { return; }
    if ([...text].length === 1 && !table.has(text)) table.set(text, bytes);
  };
  for (let byte = 0x80; byte <= 0xff; byte++) add(Buffer.from([byte]));
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) add(Buffer.from([lead, trail]));
  }
  legacyTables.set(label, table);
  return table;
}

function encodeLegacy(text, label) {
  const table = legacyTable(label);
  const bytes = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const encoded = table.get(char);
    if (!encoded) throw new TextError(`字符“${char}”无法用 ${label} 编码表示。如需改用 UTF-8，请用 write_file 并指定 encoding: "utf8"`);
    bytes.push(...encoded);
  }
  return Buffer.from(bytes);
}

// Dominant line ending of existing text; undefined when it has no line breaks to copy.
export function eolOf(text) {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  if (crlf === 0 && lf === 0) return undefined;
  return crlf >= lf ? "\r\n" : "\n";
}

export function withEol(text, eol) {
  return text.replace(/\r?\n/g, eol);
}

export function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// Exact replacement that ignores CRLF/LF differences between the caller's strings and the file.
// Everything outside the replaced ranges keeps its original characters, including line endings.
export function replaceExact(text, oldString, newString, replaceAll) {
  const needle = oldString.replace(/\r\n/g, "\n");
  if (!needle) throw new TextError("old_string 不能为空。新建文件请用 write_file");

  // The search runs on LF-normalized text. crlfAt lists, in normalized offsets, the line breaks that
  // are CRLF in the original, so an offset maps back by adding the number of CRLFs before it.
  const crlfAt = [];
  for (let at = text.indexOf("\r\n"); at !== -1; at = text.indexOf("\r\n", at + 2)) crlfAt.push(at - crlfAt.length);
  const normalized = text.replace(/\r\n/g, "\n");
  let crlfBefore = 0;
  const original = (offset) => {
    while (crlfBefore < crlfAt.length && crlfAt[crlfBefore] < offset) crlfBefore++;
    return offset + crlfBefore;
  };

  const starts = [];
  for (let at = normalized.indexOf(needle); at !== -1; at = normalized.indexOf(needle, at + needle.length)) starts.push(at);
  const lineOf = (offset) => normalized.slice(0, offset).split("\n").length;
  if (starts.length === 0) {
    throw new TextError("没有找到 old_string。请先用 read_file 确认原文，缩进和空白必须完全一致，且不要带行号前缀");
  }
  if (starts.length > 1 && !replaceAll) {
    const lines = starts.slice(0, 10).map(lineOf).join("、");
    throw new TextError(`old_string 出现了 ${starts.length} 次（第 ${lines} 行）。请加入更多上下文使其唯一，或设置 replace_all: true`);
  }

  const replacement = withEol(newString, eolOf(text) ?? "\n");
  let result = "";
  let end = 0;
  for (const start of starts) {
    result += text.slice(end, original(start)) + replacement;
    end = original(start + needle.length);
  }
  return { text: result + text.slice(end), lines: starts.map(lineOf) };
}

const ansiEscape = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// One line of command output. Tools on the same machine disagree about UTF-8 versus the console
// code page, so each line is tried as UTF-8 first and falls back to the code page.
export function decodeOutputLine(bytes, legacyEncoding) {
  let text;
  try {
    text = strictDecode("utf-8", bytes);
  } catch {
    text = decoderOf(lenientDecoders, legacyEncoding).decode(bytes);
  }
  // NUL: UTF-16 output read as bytes. U+FEFF: the BOM some programs put in front of UTF-8 output.
  text = text.replace(ansiEscape, "").replace(/[\0\ufeff]/g, "");
  if (text.endsWith("\r")) text = text.slice(0, -1);
  // A carriage return rewinds the line (progress bars); keep what would remain visible.
  return text.slice(text.lastIndexOf("\r") + 1);
}
