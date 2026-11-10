import fs from "node:fs";
import readline from "node:readline";

export interface TextSlice {
  rows: string[];
  startLine: number;
  endLine: number;
  linesSeen: number;
  hasMore: boolean;
  capped: boolean;
}

/**
 * Read arbitrary line ranges from very large text files with bounded memory.
 * Only returned rows are retained; lines before the requested offset stream
 * through without being accumulated.
 */
export async function readTextLines(
  file: string,
  startLine: number,
  lineLimit: number,
  maxBytes: number,
): Promise<TextSlice> {
  const input = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 128 * 1024 });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const rows: string[] = [];
  let lineNo = 0;
  let bytes = 0;
  let hasMore = false;
  let capped = false;
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < startLine) continue;
      if (rows.length >= lineLimit) {
        hasMore = true;
        break;
      }
      const shown = line.length > 100_000 ? line.slice(0, 100_000) + "...[line clipped]" : line;
      const rendered = String(lineNo).padStart(6) + "| " + shown;
      const cost = Buffer.byteLength(rendered, "utf8") + 1;
      if (bytes + cost > maxBytes) {
        capped = true;
        hasMore = true;
        break;
      }
      rows.push(rendered);
      bytes += cost;
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return {
    rows,
    startLine,
    endLine: rows.length ? startLine + rows.length - 1 : startLine,
    linesSeen: lineNo,
    hasMore,
    capped,
  };
}
