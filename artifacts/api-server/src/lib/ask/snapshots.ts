import type { Answer, Chart, Dataset } from "./validation";
import { categoryLabel, fieldLabel, metricLabel, seriesLabel } from "@workspace/elexon-labels";

const colors = ["#61A9BD", "#CED14E", "#44986D", "#DD83C9", "#1F74AD", "#E98E2E", "#9267C6", "#8D6C5B", "#D8524F", "#979797"];
export const escapeXml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
function text(x: number, y: number, value: unknown, size = 12, anchor = "start") {
  return `<text x="${x}" y="${y}" font-family="DejaVu Sans, sans-serif" font-size="${size}" text-anchor="${anchor}" fill="#172336">${escapeXml(value)}</text>`;
}
function svg(body: string, height = 480) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}"><rect width="1000" height="${height}" fill="#faf8f3"/>${body}</svg>`;
}
const display = (value: number, unit: string) => `${value.toLocaleString("en-GB", { maximumFractionDigits: 2 })}${unit === "%" ? "%" : ` ${unit}`}`;
function horizontalSvg(chart: Chart, dataset: Dataset) {
  const values = dataset.rows.flatMap((r) => chart.yKeys.map((k) => r[k])).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const low = Math.min(0, ...values), high = Math.max(0, ...values), span = high - low || 1;
  const x = (n: number) => 325 + (n - low) / span * 425;
  const rowHeight = Math.max(28, chart.yKeys.length * 16 + 8), height = Math.max(300, dataset.rows.length * rowHeight + 170);
  let body = text(25, 28, metricLabel(chart.title).slice(0, 115), 17) + text(25, 51, `Unit: ${chart.unit} · ranked category values`);
  body += `<path d="M${x(0)},70 V${height - 90} M325,${height - 90} H750" fill="none" stroke="#7a8391"/>`;
  dataset.rows.forEach((row, i) => {
    const top = 80 + i * rowHeight;
    body += text(310, top + 10, String(categoryLabel(chart.xKey, row[chart.xKey])).slice(0, 44), 11, "end");
    chart.yKeys.forEach((key, s) => {
      const value = row[key];
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      const y = top + s * 16;
      body += `<rect x="${Math.min(x(0), x(value))}" y="${y}" width="${Math.abs(x(value) - x(0))}" height="12" fill="${colors[s % colors.length]}"/>`;
      body += text(value >= 0 ? x(value) + 6 : x(value) - 6, y + 10, display(value, chart.unit), 11, value >= 0 ? "start" : "end");
    });
  });
  chart.yKeys.forEach((key, i) => { body += text(30 + i * 240, height - 55, seriesLabel(key), 11); });
  body += text(25, height - 25, `Source: Elexon Insights · Retrieved ${dataset.fetchedAt} · ${dataset.truncated ? "Incomplete observations" : "Query-scoped observations"}; see report for denominator and filters.`, 10);
  return svg(body, height);
}
export function chartSvg(chart: Chart, dataset: Dataset): string {
  if (chart.kind === "horizontalBar") return horizontalSvg(chart, dataset);
  const rows = dataset.rows;
  const numbers = rows.flatMap((r) => chart.yKeys.map((key) => r[key])).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!numbers.length) return svg(text(35, 55, "No numeric observations available"));
  const stacked = chart.kind === "stackedArea" || chart.kind === "stackedBar";
  const bounds = stacked ? rows.map((row) => chart.yKeys.reduce((sum, key) => sum + Number(row[key] ?? 0), 0)) : numbers;
  const low = chart.kind === "line" || chart.kind === "scatter" ? Math.min(...numbers) : Math.min(0, ...numbers);
  const high = chart.kind === "line" ? Math.max(...numbers) : Math.max(0, ...bounds);
  const span = high - low || 1;
  const y = (v: number) => 350 - (v - low) / span * 235;
  const timestamps = rows.map((r) => typeof r[chart.xKey] === "string" && /^\d{4}-\d{2}-\d{2}T/.test(String(r[chart.xKey])) ? Date.parse(String(r[chart.xKey])) : NaN);
  const time = timestamps.every(Number.isFinite) && new Set(timestamps).size > 1;
  const minTime = Math.min(...timestamps), maxTime = Math.max(...timestamps);
  const numericX = rows.map((row) => Number(row[chart.xKey])), minX = Math.min(...numericX), maxX = Math.max(...numericX);
  const bars = chart.kind === "bar" || chart.kind === "stackedBar";
  const left = bars ? 130 : 90, width = bars ? 710 : 790;
  const x = (i: number) => rows.length === 1 ? 485 : chart.kind === "scatter" ? left + (numericX[i] - minX) / (maxX - minX || 1) * width : time ? left + (timestamps[i] - minTime) / (maxTime - minTime) * width : left + i / (rows.length - 1) * width;
  let body = text(35, 30, metricLabel(chart.title).slice(0, 125), 17) + text(35, 53, `Unit: ${chart.unit} · ${chart.kind} · bounded returned observations`, 12);
  if (["composition", "pie", "donut"].includes(chart.kind)) {
    const values = rows.map((r) => Number(r[chart.yKeys[0]] ?? 0));
    const total = values.reduce((a, b) => a + b, 0);
    let start = -Math.PI / 2;
    rows.forEach((row, i) => {
      const angle = total > 0 ? values[i] / total * 2 * Math.PI : 0;
      if (angle <= 0) return;
      if (angle >= Math.PI * 2 - 0.00001) body += `<circle cx="270" cy="240" r="145" fill="${colors[i % colors.length]}"/>`;
      else body += `<path d="M270,240 L${270 + Math.cos(start) * 145},${240 + Math.sin(start) * 145} A145,145 0 ${angle > Math.PI ? 1 : 0},1 ${270 + Math.cos(start + angle) * 145},${240 + Math.sin(start + angle) * 145} Z" fill="${colors[i % colors.length]}"/>`;
      if (angle / (2 * Math.PI) >= .035) body += text(270 + Math.cos(start + angle / 2) * 116, 244 + Math.sin(start + angle / 2) * 116, `${(values[i] / total * 100).toFixed(1)}%`, 12, "middle");
      if (i < 20) body += `<rect x="450" y="${77 + i * 17}" width="11" height="11" fill="${colors[i % colors.length]}"/>` + text(470, 87 + i * 17, `${String(categoryLabel(chart.xKey, row[chart.xKey])).slice(0, 30)}: ${(values[i] / total * 100).toFixed(2)}% · ${display(values[i], chart.unit)}`, 10);
      start += angle;
    });
    if (chart.kind === "donut") body += `<circle cx="270" cy="240" r="74" fill="#faf8f3"/>`;
    if (rows.length > 20) body += text(450, 442, "Additional category labels are in the data table.");
  } else {
    body += `<path d="M80,90 V350 H900${low <= 0 && high >= 0 ? ` M80,${y(0)} H900` : ""}" stroke="#7a8391" fill="none"/>`;
    for (let tick = 0; tick < 5; tick++) {
      const value = low + span * tick / 4;
      body += text(70, y(value) + 4, `${value.toLocaleString("en-GB", { maximumFractionDigits: chart.unit === "Hz" ? 3 : 1 })}${chart.unit === "%" ? "%" : ""}`, 10, "end");
    }
    const cumulative = rows.map(() => 0);
    chart.yKeys.forEach((key, s) => {
      const color = colors[s % colors.length];
      const base = [...cumulative];
      const points = rows.map((r, i) => {
        if (typeof r[key] !== "number" || !Number.isFinite(r[key])) return null;
        cumulative[i] += r[key] as number;
        return { x: x(i), y: y(stacked ? cumulative[i] : r[key] as number), i };
      });
      if (chart.kind === "bar" || chart.kind === "stackedBar") {
        const width = Math.max(0.5, Math.min(80, 650 / rows.length) / chart.yKeys.length);
        points.forEach((p) => {
          if (!p) return;
          const bottom = y(stacked ? base[p.i] : 0);
          body += `<rect x="${p.x + (stacked ? 0 : s * width) - width * chart.yKeys.length / 2}" y="${Math.min(p.y, bottom)}" width="${stacked ? width * chart.yKeys.length : width}" height="${Math.abs(bottom - p.y)}" fill="${color}"/>`;
          if (chart.unit === "%" && rows.length <= 25 && !stacked) body += text(p.x, p.y - 5, display(Number(rows[p.i][key]), "%"), 10, "middle");
        });
      } else if (chart.kind === "scatter") {
        points.forEach((p) => { if (p) body += `<circle cx="${p.x}" cy="${p.y}" r="4" fill="${color}"/>`; });
      } else {
        const segments: { x: number; y: number; i: number }[][] = [];
        for (const p of points) {
          if (!p) { segments.push([]); continue; }
          if (!segments.length) segments.push([]);
          segments[segments.length - 1].push(p);
        }
        for (const part of segments.filter((v) => v.length)) {
          const path = part.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
          if (chart.kind === "area" || chart.kind === "stackedArea") {
            const lower = [...part].reverse().map((p) => `L${p.x},${y(stacked ? base[p.i] : 0)}`).join(" ");
            body += `<path d="${path} ${lower} Z" fill="${color}" fill-opacity="${stacked ? ".75" : ".22"}"/>`;
          }
          body += `<path d="${path}" stroke="${color}" stroke-width="2" fill="none"/>`;
          if (chart.unit === "%" && rows.length <= 25 && !stacked) for (const p of part) body += text(p.x, p.y - 6, display(Number(rows[p.i][key]), "%"), 10, "middle");
        }
      }
      const lx = 50 + (s % 8) * 115, ly = 430 + Math.floor(s / 8) * 20;
      body += `<rect x="${lx}" y="${ly}" width="10" height="10" fill="${color}"/>` + text(lx + 14, ly + 10, seriesLabel(key).slice(0, 15), 10);
    });
    const indexes = [...new Set([0, Math.floor(rows.length / 2), rows.length - 1])];
    for (const i of indexes) body += text(x(i), 378, String(categoryLabel(chart.xKey, rows[i][chart.xKey])).slice(0, 28), 10, "middle");
    body += text(480, 409, `${fieldLabel(chart.xKey)}${time ? " (UTC / explicit offset)" : ""}`, 12, "middle");
  }
  body += text(35, 473, `Source: Elexon Insights · Retrieved ${dataset.fetchedAt} · ${dataset.truncated ? "BOUNDED/INCOMPLETE DATA" : "Query-scoped data"} · See filters and series mapping in report.`, 10);
  return svg(body, 490);
}
export function diagramSvg(diagram: Answer["diagram"]) {
  const height = Math.max(220, diagram.nodes.length * 75 + 70);
  let body = text(25, 30, diagram.title, 18) + text(25, 54, "Relationships, not measured flows; verified query provenance only.", 12);
  const positions = new Map(diagram.nodes.map((n, i) => [n.id, { x: i ? 550 : 50, y: i ? 70 + i * 70 : height / 2 }]));
  for (const edge of diagram.edges) {
    const a = positions.get(edge.from), b = positions.get(edge.to);
    if (a && b) body += `<path d="M${a.x + 310},${a.y} L${b.x},${b.y}" stroke="#44986D" stroke-width="2"/>` + text((a.x + b.x + 310) / 2, (a.y + b.y) / 2 - 6, edge.label, 10, "middle");
  }
  for (const node of diagram.nodes) {
    const p = positions.get(node.id)!;
    body += `<rect x="${p.x}" y="${p.y - 22}" width="310" height="44" rx="7" fill="#e4f0e9" stroke="#44986D"/>` + text(p.x + 10, p.y + 4, node.label.slice(0, 42), 11);
  }
  return svg(body, height);
}
