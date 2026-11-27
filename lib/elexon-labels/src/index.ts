// Presentation only. API filters, raw records and chart lookup keys stay intact.
const fuels: Record<string, string> = {
  BIOMASS: "Biomass", CCGT: "Gas (combined cycle)", OCGT: "Gas (open cycle)",
  COAL: "Coal", NUCLEAR: "Nuclear", WIND: "Wind", SOLAR: "Solar", OIL: "Oil",
  NPSHYD: "Hydro (non-pumped storage)", PS: "Pumped storage", OTHER: "Other",
  INTELE: "ElecLink interconnector", INTELEC: "France interconnector (IFA)",
  INTEW: "East–West interconnector", INTFR: "France interconnector",
  INTGRNL: "Greenlink interconnector", INTIFA2: "IFA2 interconnector",
  INTIRL: "Moyle interconnector", INTNED: "BritNed interconnector",
  INTNEM: "Nemo Link interconnector", INTNSL: "North Sea Link interconnector",
  INTVKL: "Viking Link interconnector", INTERCONNECTOR: "Interconnector",
};
const production: Record<string, string> = {
  B01: "Biomass", B02: "Lignite", B03: "Coal-derived gas", B04: "Fossil gas",
  B05: "Hard coal", B06: "Oil", B07: "Oil shale", B08: "Peat",
  B09: "Geothermal", B10: "Hydro (pumped storage)", B11: "Hydro (run-of-river)",
  B12: "Hydro (reservoir)", B13: "Marine", B14: "Nuclear", B15: "Other renewables",
  B16: "Solar", B17: "Waste", B18: "Wind (offshore)", B19: "Wind (onshore)", B20: "Other",
};
const datasets: Record<string, string> = {
  FUELHH: "Half-hourly generation by fuel", FUELINST: "Instantaneous generation by fuel",
  AGPT: "Actual generation by production type", INDO: "Initial national demand",
  ITSDO: "Initial transmission system demand", WINDFOR: "Wind generation forecast",
};
const fields: Record<string, string> = {
  psrType: "Production type", bmUnit: "Balancing mechanism unit", nationalGridBmUnit: "National Grid BM unit",
  elexonBmUnit: "Elexon BM unit", fuelType: "Fuel type", startTime: "Start time", publishTime: "Publication time",
  systemSellPrice: "System sell price", systemBuyPrice: "System buy price",
  settlementDate: "Settlement date", settlementPeriod: "Settlement period",
  quantity: "Quantity", generation: "Generation", frequency: "Frequency",
};
const known = (entries: Record<string, string>, key: string) => Object.hasOwn(entries, key) ? entries[key] : undefined;
export function fieldLabel(key: string): string {
  if (key.startsWith("Measure: ")) return seriesLabel(key);
  return known(fields, key) ?? key.split(".").map((part) => {
    const words = part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
  }).join(" · ");
}
export function categoryLabel(field: string, value: unknown, includeCode = false): unknown {
  if (typeof value !== "string") return value;
  const key = field.split(".").at(-1)?.toLowerCase();
  const code = value.toUpperCase();
  const name = key === "fueltype" ? known(fuels, code)
    : key === "psrtype" ? known(production, code) ?? known(fuels, code)
    : key === "dataset" ? known(datasets, code) : undefined;
  return name ? includeCode && name !== value ? `${name} (${value})` : name : value;
}
export function seriesLabel(key: string): string {
  const raw = key.replace(/^Measure: /, "");
  return known(fuels, raw) ?? known(production, raw) ?? (/^[A-Z][A-Z0-9_]*$/.test(raw) ? raw : fieldLabel(raw));
}
export function tableHeading(key: string): string {
  const label = fieldLabel(key);
  return label === key ? label : `${label} (${key})`;
}
export function metricLabel(label: string): string {
  return label.replace(/\b(?:psrType|fuelType|startTime|settlementDate|settlementPeriod|systemSellPrice|systemBuyPrice|quantity|generation|frequency)\b/g, (key) => fieldLabel(key).toLowerCase());
}
