/**
 * Public ad-hoc charging tariffs per operator, CHF per kWh, as published on
 * each operator's own price page. The federal feed carries no prices, so
 * this table is the app's only source, and it is only as good as its dates:
 * a test fails once an entry is older than STALE_AFTER_DAYS, so a stale
 * price cannot ship unnoticed. Update the number, the date and the source
 * together.
 *
 * Operator names are spelled as the federal feed spells them.
 */
export interface Tariff {
  operator: string;
  /** Ad-hoc AC price; null when the operator publishes none. */
  ac: number | null;
  /** Ad-hoc DC (fast charging) price; null when the operator publishes none. */
  dc: number | null;
  /** ISO date the price page was last read. */
  checkedOn: string;
  /** The page the numbers were read from. */
  source: string;
  /** Prices are set per site (platforms) or per time of day; the number is typical. */
  varies?: boolean;
  /** Idle / blocking fee as the operator states it, if any. */
  blockingFee?: string;
  note?: string;
}

/** How long a checked price is trusted before the test starts nagging. */
export const STALE_AFTER_DAYS = 90;

/** Used for operators with no entry; deliberately mid-market. */
export const DEFAULT_TARIFF = { ac: 0.45, dc: 0.65 } as const;

/*
 * Checked 2026-09-10. Operators researched but left out because they publish
 * no ad-hoc price of their own (per-site, app-only, or the page could not be
 * read), so they get the default: eCarUp, swisscharge.ch AG, Shell Recharge,
 * GoFast, Autosense, Agrola, Power Up, Saascharge, PLUG N ROLL, evpass,
 * Elektrizitätswerk Obwalden.
 */
export const TARIFFS: Tariff[] = [
  {
    operator: "Move",
    ac: 0.57,
    dc: 0.69,
    checkedOn: "2026-09-10",
    source: "https://move.ch/en/private/subscriptions/move-light.php",
    varies: true,
    blockingFee: "CHF 0.25/min from the 61st minute (DC)",
    note: "“From” prices on MOVE light (no fee, account needed); the no-account rate is not published",
  },
  {
    operator: "M-Charge",
    ac: 0.38,
    dc: 0.59,
    checkedOn: "2026-09-10",
    source: "https://www.migrol.ch/de/mobilit%C3%A4t/e-mobilit%C3%A4t/ladestationen-%C3%B6ffentlich/",
    note: "Tiered by power: <64 kW 0.48, <200 kW 0.55, <400 kW 0.59; DC shows the top tier",
  },
  {
    operator: "Energie 360 Grad AG",
    ac: 0.55,
    dc: 0.69,
    checkedOn: "2026-09-10",
    source: "https://www.energie360.ch/de/leistungen/mobilitaet/easycharge/",
    varies: true,
    blockingFee: "AC CHF 6/h after 6 h; DC <100 kW CHF 9/h after 2 h; DC ≥100 kW CHF 15/h after 1 h",
    note: "DC <100 kW is 0.65; cheaper at Coop sites (0.39 / 0.55)",
  },
  {
    operator: "IWB Industrielle Werke Basel",
    ac: 0.48,
    dc: 0.64,
    checkedOn: "2026-09-10",
    source: "https://www.iwb.ch/servicecenter/oeffentliches-ladenetz/mobilitaet-tarife",
    blockingFee: "DC ≤150 kW: CHF 0.25/min after 60 min; DC ≤50 kW: CHF 0.15/min after 150 min",
    note: "DC ≤50 kW is 0.60",
  },
  {
    operator: "Tesla",
    ac: null,
    dc: 0.59,
    checkedOn: "2026-09-10",
    source: "https://www.tesla.com/de_ch/findus/location/supercharger/bullesupercharger",
    varies: true,
    blockingFee: "Congestion fee up to CHF 0.50/min when the site is busy",
    note: "Non-Tesla base rate at Bulle; prices vary per site and time of day (0.46–0.68 there)",
  },
  {
    operator: "Elektrizitätswerk der Stadt Zürich",
    ac: 0.5,
    dc: 0.6,
    checkedOn: "2026-09-10",
    source: "https://www.ewz.ch/de/geschaeftskunden/elektromobilitaet/unterwegs-laden/oeffentliches-ladenetz.html",
    blockingFee: "CHF 0.15/min after 4 h (AC) or 1 h (DC)",
    note: "Rate when charging with the ewz mobil app; roaming prices differ",
  },
  {
    operator: "Lidl Schweiz AG",
    ac: 0.5,
    dc: 0.62,
    checkedOn: "2026-09-10",
    source: "https://www.lidl.ch/c/de-CH/e-ladesaeulen/s10023632",
    note: "Without Lidl Plus; 0.26 / 0.42 with it. Store hours only",
  },
  {
    operator: "Electra",
    ac: null,
    dc: 0.69,
    checkedOn: "2026-09-10",
    source: "https://www.go-electra.com/en/price/",
    note: "DC-only network; flat rate across Switzerland",
  },
  {
    operator: "Fastned",
    ac: null,
    dc: 0.75,
    checkedOn: "2026-09-10",
    source: "https://www.fastnedcharging.com/en/charging/tariffs",
    note: "DC-only network; 0.53 with Gold membership",
  },
  {
    operator: "ebs Energie AG",
    ac: 0.47,
    dc: 0.55,
    checkedOn: "2026-09-10",
    source: "https://www.ebs.swiss/privatkunden/energie/energiedienstleistungen/elektromobilitaet/stromtankstellen/",
    varies: true,
    blockingFee: "CHF 0.25/min after the 61st minute (DC hubs)",
  },
];

const byOperator = new Map(TARIFFS.map((tariff) => [tariff.operator, tariff]));

export function tariffFor(operator: string): Tariff | undefined {
  return byOperator.get(operator);
}

/** Days since the entry was checked, against the given "today". */
export function tariffAgeDays(tariff: Tariff, today: Date): number {
  return Math.floor((today.getTime() - Date.parse(tariff.checkedOn)) / 86_400_000);
}
