// helpers/alerts-csv.ts
import fs from "fs";
import path from "path";

/**
 * Kolom disusun mengikuti screenshot:
 * TIER, Timestamp, Timeframe, Session, POI Type, Event, Previous Candle,
 * Delta total, avg delta, Delta, Delta change (x), OI change, Liq,
 * MFE (%), MAE (%), RR, MFE to Trigger, Outcome
 */
type AlertCsvRow = {
  TIER: "S" | "A" | "B" | string;
  Timestamp: string; // ISO
  Timeframe: string; // "5", "15", "30"
  Session: "Asia" | "London" | "NY" | "";
  POIType: string; // gabungan note OI/Liq (atau sesuai selera)
  Level?: string; // label: "Monday High"
  LevelPrice?: number | "";
  LevelDistPct?: number | ""; // mis. 0.32
  Event: "Breakout" | "Breakdown" | string;
  PreviousCandle: number; // prevCount (baseline history)
  DeltaTotal: number; // delta sekarang (signed)
  AvgDelta: number; // avgDelta (signed, baseline prev)
  Delta: number; // |delta| (abs)
  DeltaChangex: number; // rΔ (ratio)
  AvgOiChange: number; // avg oi prev candle
  currentOiChange: number; //current candle oi - prev candle oi
  oiChange: number; // curremt oi change / avg oi change
  LiqPct: number | ""; // % likuidasi relatif volume candle (opsional)
  MFEpct: number | ""; // tak tersedia -> ""
  MAEpct: number | ""; // tak tersedia -> ""
  RR: number | ""; // tak tersedia -> ""
  MFEtoTrigger: string; // tak tersedia -> ""
  Outcome: "Follow up" | "Failed" | ""; // hasil trading (tak tersedia)
};

// ====== CONFIG / STATE ======
let dir = "./logs";
let prefix = "alerts";
let flushEvery = 1000;
let enabled = true;
let rotateDaily = true;

let q: string[] = [];
let timer: NodeJS.Timeout | undefined;
let stream: fs.WriteStream | undefined;
let currentDate = "";

export function initAlertsCsv(opts?: {
  dir?: string;
  filePrefix?: string;
  flushEvery?: number;
  enabled?: boolean;
  rotateDaily?: boolean;
}) {
  dir = opts?.dir ?? "./logs";
  prefix = opts?.filePrefix ?? "alerts";
  flushEvery = opts?.flushEvery ?? 1000;
  enabled = opts?.enabled ?? true;
  rotateDaily = opts?.rotateDaily ?? true;

  if (!enabled) return;
  fs.mkdirSync(dir, { recursive: true });
  ensureStream();
  timer = setInterval(() => flushAlertsCsv(), flushEvery);
  (timer as any).unref?.();
}

export function closeAlertsCsv() {
  try {
    flushAlertsCsv(true);
  } catch {}
  if (timer) clearInterval(timer);
  timer = undefined;
  stream?.end();
  stream = undefined;
}

export function logAlertCsv(row: AlertCsvRow) {
  if (!enabled) return;

  // rotasi harian
  if (rotateDaily) {
    const d = new Date();
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(d.getDate()).padStart(2, "0")}`;
    if (ds !== currentDate) {
      flushAlertsCsv(true);
      ensureStream();
    }
  }

  // urutan kolom tetap (sinkron dengan header)
  const line = toCsvLine([
    row.TIER,
    row.Timestamp,
    row.Timeframe,
    row.Session,
    row.POIType,
    row.Event,
    row.PreviousCandle,
    row.DeltaTotal,
    row.AvgDelta,
    row.Delta,
    row.DeltaChangex,
    row.AvgOiChange,
    row.currentOiChange,
    row.oiChange,
    fmtNum(row.LiqPct),
    fmtNum(row.MFEpct),
    fmtNum(row.MAEpct),
    fmtNum(row.RR),
    row.MFEtoTrigger,
    row.Outcome,
  ]);
  q.push(line);
}

export function flushAlertsCsv(force = false) {
  if (!enabled || !stream) return;
  if (!q.length && !force) return;
  const chunk = q.join("");
  q.length = 0;
  if (!stream.write(chunk)) stream.once("drain", () => {});
}

// ====== helpers ======
function ensureStream() {
  const d = new Date();
  const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getDate()).padStart(2, "0")}`;
  currentDate = ds;

  const file = path.join(dir, `${prefix}-${ds}.csv`);
  const isNew = !fs.existsSync(file);

  stream?.end();
  stream = fs.createWriteStream(file, { flags: "a" });

  if (isNew) {
    const header = toCsvLine([
      "TIER",
      "Timestamp",
      "Timeframe",
      "Session",
      "POI Type",
      "Level",
      "Level Price",
      "Level Dist (%)",
      "Event",
      "Previous Candle",
      "Delta total",
      "avg delta",
      "Delta",
      "Delta change (x)",
      "Avg OI change",
      "Current OI change",
      "OI change",
      "Liq",
      "MFE (%)",
      "MAE (%)",
      "RR",
      "MFE to Trigger",
      "Outcome",
    ]);
    stream.write(header);
  }
}

function toCsvLine(cols: any[]) {
  const esc = (v: any) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return cols.map(esc).join(",") + "\n";
}
function fmtNum(v: number | "" | undefined) {
  return typeof v === "number" && Number.isFinite(v) ? v : "";
}
