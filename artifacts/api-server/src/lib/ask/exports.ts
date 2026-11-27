import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ImageRun, HeadingLevel } from "docx";
import sharp from "sharp";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { create as createFont } from "fontkit";
import type { Answer, Dataset } from "./validation";
import { chartSvg, diagramSvg } from "./snapshots";
import { categoryLabel, metricLabel, tableHeading } from "@workspace/elexon-labels";

export type ExportFormat = "xlsx" | "docx" | "pdf";
export const exportTypes: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};
// ExcelJS string cell types are explicit; leading apostrophe also protects downstream CSV copies.
export function spreadsheetValue(value: unknown): string | number | boolean {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /^[\s\u0000-\u001f]*[=+@-]/.test(text) ? `'${text}` : text;
}
const stringValue = (v: unknown) => v == null ? "— (missing)" : typeof v === "object" ? JSON.stringify(v) : String(v);
function metadata(answer: Answer) {
  return [
    `Question: ${answer.question}`, `Generated: ${answer.createdAt}`, `Date semantics: ${answer.timezone}`,
    "Independent project. Not affiliated with or endorsed by Elexon. Source: Elexon Insights public API.",
    "All metrics and visuals are calculated from bounded query results, not an exhaustive market archive.",
    ...answer.limitations.map((s) => `Limitation: ${s}`),
    ...answer.metrics.map((m) => `${metricLabel(m.label)}: ${m.value} ${m.unit}. ${m.calculation} [${m.datasetId}]`),
  ];
}
function datasetNotes(d: Dataset) {
  return [
    `${d.id} — ${d.tool}`, `Source: ${d.sourceUrl}`, `Retrieved: ${d.fetchedAt}`,
    `Filters: ${JSON.stringify(d.arguments)}`, `Coverage: ${d.coverage}`,
    `Upstream metadata: ${JSON.stringify(d.metadata ?? {})}. Next local page offset: ${d.nextOffset ?? "none"}.`,
    `${d.count} displayed rows; ${d.totalCount} upstream records; incomplete: ${d.truncated}.`, d.note,
  ];
}
async function snapshots(a: Answer) {
  const values: { title: string; bytes: Buffer }[] = [];
  for (const c of a.charts) {
    const d = a.datasets.find((d) => d.id === c.datasetId);
    if (d) values.push({ title: c.title, bytes: await sharp(Buffer.from(chartSvg(c, d))).png().toBuffer() });
  }
  if (a.diagram.nodes.length) values.push({ title: a.diagram.title, bytes: await sharp(Buffer.from(diagramSvg(a.diagram))).png().toBuffer() });
  return values;
}
async function excel(answer: Answer) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Grid MCP";
  workbook.created = new Date(answer.createdAt);
  const analysis = workbook.addWorksheet("Analysis and sources");
  analysis.columns = [{ width: 110 }];
  for (const line of [answer.title, answer.narrative, ...metadata(answer)]) {
    const row = analysis.addRow([spreadsheetValue(line)]);
    row.getCell(1).alignment = { wrapText: true, vertical: "top" };
    row.height = Math.min(180, Math.max(20, Math.ceil(line.length / 100) * 16));
  }
  for (const [i, d] of answer.datasets.entries()) {
    const sheet = workbook.addWorksheet(`Data ${i + 1}`);
    sheet.columns = d.columns.map(() => ({ width: 25 }));
    for (const note of datasetNotes(d)) sheet.addRow([spreadsheetValue(note)]);
    sheet.addRow([]);
    sheet.addRow(d.columns.map((c) => spreadsheetValue(`${tableHeading(c.key)} [${c.unit}]`)));
    const headerRow = sheet.rowCount;
    sheet.getRow(headerRow).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(headerRow).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF172336" } };
    for (const r of d.rows) sheet.addRow(d.columns.map((c) => spreadsheetValue(categoryLabel(c.key, r[c.key], true))));
    sheet.views = [{ state: "frozen", ySplit: headerRow }];
    if (d.columns.length) sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow + d.rows.length, column: d.columns.length } };
  }
  const images = await snapshots(answer);
  if (images.length) {
    const sheet = workbook.addWorksheet("Visual snapshots");
    images.forEach((image, i) => {
      const id = workbook.addImage({ buffer: image.bytes as unknown as ExcelJS.Buffer, extension: "png" });
      sheet.addImage(id, { tl: { col: 0, row: i * 29 }, ext: { width: 900, height: 440 } });
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
function bands(d: Dataset) {
  const result: typeof d.columns[] = [];
  for (let i = 0; i < d.columns.length; i += 5) result.push(d.columns.slice(i, i + 5));
  return result;
}
async function word(answer: Answer) {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: answer.title, heading: HeadingLevel.TITLE }),
    new Paragraph(answer.narrative),
    ...metadata(answer).map((text) => new Paragraph(text)),
  ];
  for (const image of await snapshots(answer)) {
    const dims = await sharp(image.bytes).metadata();
    children.push(new Paragraph({ text: image.title, heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ children: [new ImageRun({ data: image.bytes, type: "png", transformation: { width: 620, height: Math.round(620 * (dims.height ?? 490) / (dims.width ?? 1000)) }, altText: { title: image.title, description: "Visual snapshot from the validated bounded query data.", name: image.title } })] }));
  }
  for (const d of answer.datasets) {
    children.push(new Paragraph({ text: d.id, heading: HeadingLevel.HEADING_1 }));
    children.push(...datasetNotes(d).map((s) => new Paragraph(s)));
    children.push(new Paragraph(`Readable report preview: first ${Math.min(50, d.rows.length)} of ${d.rows.length} saved rows. Excel contains every saved row. Wide tables are split into column bands with matching row numbers.`));
    if (!d.rows.length) children.push(new Paragraph("No rows returned. Missing data is not zero."));
    for (const band of bands(d)) {
      const row = (values: string[], header = false) => new TableRow({ tableHeader: header, cantSplit: false, children: values.map((value) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: value, bold: header, size: 16 })] })], width: { size: 100 / (band.length + 1), type: WidthType.PERCENTAGE } })) });
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
        row(["Row", ...band.map((c) => `${tableHeading(c.key)} [${c.unit}]`)], true),
        ...d.rows.slice(0, 50).map((r, i) => row([String(i + 1), ...band.map((c) => stringValue(categoryLabel(c.key, r[c.key], true)))])),
      ] }));
      children.push(new Paragraph(""));
    }
  }
  return Packer.toBuffer(new Document({ sections: [{ properties: { page: { size: { orientation: "landscape" }, margin: { top: 600, bottom: 600, left: 600, right: 600 } } }, children }] }));
}
async function pdf(answer: Answer) {
  const document = new PDFDocument({ size: "A4", margin: 42, info: { Title: answer.title, Author: "Grid MCP" } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    document.on("data", (c) => chunks.push(c));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  // A bundled Unicode font, never a user path or a remote URL.
  const font = await readFile(createRequire(import.meta.url).resolve("@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff"));
  const parsedFont = createFont(font);
  const safeText = (s: string) => [...s].map((c) => {
    const point = c.codePointAt(0)!;
    return point === 10 || point === 13 || point === 9 || ("hasGlyphForCodePoint" in parsedFont && parsedFont.hasGlyphForCodePoint(point)) ? c : `[U+${point.toString(16).toUpperCase()}]`;
  }).join("");
  document.registerFont("Report", font).font("Report");
  document.fontSize(21).text(safeText(answer.title)).moveDown();
  document.fontSize(10).text(safeText(answer.narrative)).moveDown();
  document.text("Unicode outside the embedded font is represented as [U+XXXX] in PDF text; Excel and Word retain the original characters. Visuals use available server fonts.").moveDown(0.5);
  for (const line of metadata(answer)) document.text(safeText(line)).moveDown(0.5);
  for (const image of await snapshots(answer)) {
    document.addPage();
    document.fontSize(14).text(safeText(image.title)).moveDown();
    document.image(image.bytes, { fit: [510, 530] }).moveDown();
  }
  for (const d of answer.datasets) {
    document.addPage();
    document.fontSize(14).text(d.id).moveDown(0.5);
    document.fontSize(9);
    for (const note of datasetNotes(d)) document.text(safeText(note)).moveDown(0.4);
    document.text(`TABLE PREVIEW: first ${Math.min(50, d.rows.length)} of ${d.rows.length} saved rows. Excel contains all saved rows. Wide tables split into column bands; row numbers align between bands.`).moveDown();
    if (!d.rows.length) document.text("No data returned. Missing data is not zero.");
    for (const band of bands(d)) {
      const width = 510 / (band.length + 1);
      const headers = ["Row", ...band.map((c) => `${tableHeading(c.key)} [${c.unit}]`)];
      const render = (values: string[], header = false) => {
        // Wrapped cells can exceed a page; split each into bounded lines and continue as
        // another table row rather than drawing beyond the page or dropping text.
        const split = values.map((raw) => {
          const value = safeText(raw);
          const lines: string[] = [];
          let line = "";
          for (const char of value) {
            if (char === "\n" || document.widthOfString(line + char) > width - 10) { lines.push(line); line = ""; }
            if (char !== "\n") line += char;
          }
          lines.push(line);
          return lines;
        });
        const maxLines = Math.max(...split.map((v) => v.length));
        for (let start = 0; start < maxLines; start += 32) {
          const count = Math.min(32, maxLines - start), height = count * 12 + 12;
          if (document.y + height > 790) document.addPage();
          const top = document.y;
          split.forEach((lines, i) => {
            document.rect(42 + width * i, top, width, height).fillAndStroke(header ? "#e4f0e9" : "#faf8f3", "#d9d7d0");
            document.fillColor("#172336").text(lines.slice(start, start + 32).join("\n"), 47 + width * i, top + 5, { width: width - 10, lineBreak: false });
          });
          document.x = 42; document.y = top + height;
        }
      };
      document.fontSize(8);
      render(headers, true);
      d.rows.slice(0, 50).forEach((r, i) => render([String(i + 1), ...band.map((c) => stringValue(categoryLabel(c.key, r[c.key], true)))]));
      document.moveDown();
    }
  }
  document.end();
  return done;
}
export async function generateExport(answer: Answer, format: ExportFormat) {
  return format === "xlsx" ? excel(answer) : format === "docx" ? word(answer) : pdf(answer);
}
