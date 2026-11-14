import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { encodingOfCodePage } from "./text.mjs";

// Files and console output on Windows may use the system code pages: ACP for files, OEMCP for consoles.
export async function detectEncodings(platform = process.platform) {
  let ansi;
  let oem;
  if (platform === "win32") {
    try {
      const { stdout } = await promisify(execFile)("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage"], { windowsHide: true });
      const labelOf = (name) => encodingOfCodePage(Number(new RegExp(`\\b${name}\\s+REG_SZ\\s+(\\d+)`).exec(stdout)?.[1]));
      ansi = labelOf("ACP");
      oem = labelOf("OEMCP");
    } catch {}
  }
  // No usable code page (UTF-8 system locale, not Windows): GBK is the likeliest encoding of a stray legacy file here.
  const legacyEncoding = ansi ?? "gbk";
  return { legacyEncoding, consoleEncoding: oem ?? legacyEncoding };
}
