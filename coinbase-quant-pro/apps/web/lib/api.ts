export const API = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(API + "/api/v1" + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Request rejected; check inputs",
    );
  return data;
}
export type Frame = "1H" | "4H" | "1D" | "1W";
export type Product = {
  product_id: string;
  base_name: string;
  price: string;
  price_percentage_change_24h: string;
  volume_24h: string;
  quote_increment: string;
  alias: string;
  quote_currency_id: string;
};
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  complete: boolean;
};
export type Zone = {
  type: "support" | "resistance";
  lower: number;
  upper: number;
  strength: number;
  touches: number;
  factors: Record<string, number>;
};
export type Analysis = {
  product_id: string;
  timeframe: Frame;
  quality: string;
  observations: number;
  discarded_before_gap: number;
  history_note: string;
  source_candle: number;
  calculated_at: string;
  trend: string;
  indicators: Record<string, number | null>;
  series: Record<string, number | null>[];
  zones: Zone[];
  patterns: { name: string; time: number; status: string }[];
  warmup: string[];
  signal: { state: string; reason: string; evidence: string[]; plan: null };
};
export type CandleResponse = {
  candles: Candle[];
  quality: string;
  gaps: number[];
  fetched_at: string;
  exchange_time: number;
};
export type Book = {
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
  spread_bps: number | null;
  imbalance: number | null;
  timestamp: string;
  fetched_at: string;
  mode: string;
};
