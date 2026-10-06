// Revert This Change: the text of a file after one change of a diff goes back to the left side.

/** A change of a diff, as Monaco gives it. An end of 0 means that the side has no lines there: the change
 * is an insert or a delete, after the line of the start. */
export interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

/** The lines of a text, each with its line end. */
function lines(text: string): string[] {
  return text.split(/(?<=\n)/).filter((l) => l !== "");
}

/** The right text, with the lines of one change replaced by the lines of the left text. The line ends of
 * the right text stay. When the change reaches the end of the file, the end follows the left text. */
export function revertChange(left: string, right: string, c: LineChange): string {
  const r = lines(right);
  const from = c.originalEndLineNumber === 0 ? [] : lines(left).slice(c.originalStartLineNumber - 1, c.originalEndLineNumber);
  const start = c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber - 1;
  const count = c.modifiedEndLineNumber === 0 ? 0 : c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
  const eol = right.includes("\r\n") || (!right.includes("\n") && left.includes("\r\n")) ? "\r\n" : "\n";
  const out = [...r.slice(0, start), ...from, ...r.slice(start + count)];
  // Each line but the last needs its line end; a line from the old end of the file can have none.
  for (let i = 0; i < out.length - 1; i++) if (!out[i].endsWith("\n")) out[i] += eol;
  let text = out.join("");
  if (start + count >= r.length) {
    const leftEnds = left === "" || left.endsWith("\n");
    if (leftEnds && text !== "" && !text.endsWith("\n")) text += eol;
    if (!leftEnds) text = text.replace(/\r?\n$/, "");
  }
  return text;
}
