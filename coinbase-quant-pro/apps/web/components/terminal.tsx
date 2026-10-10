"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Blocks,
  ChevronRight,
  FlaskConical,
  History,
  LayoutDashboard,
  Radio,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  Zap,
} from "lucide-react";
import {
  api,
  type Product,
  type Frame,
  type CandleResponse,
  type Analysis,
  type Book,
} from "@/lib/api";
import { useSettings } from "@/lib/store";
import { number, stamp } from "@/lib/utils";
import { useFeed } from "@/hooks/use-feed";
import { MarketChart } from "./chart";
import { Button } from "./ui/button";
import { ResearchPages } from "./research-pages";

const frames: Frame[] = ["1H", "4H", "1D", "1W"];
const nav = [
  ["dashboard", "Overview", LayoutDashboard],
  ["markets", "Markets", BarChart3],
  ["backtesting", "Backtesting", FlaskConical],
  ["models", "Models", Blocks],
  ["signals", "Signal journal", History],
  ["settings", "Settings", Settings2],
] as const;
export function ErrorBox({ error }: { error: Error | null }) {
  return error ? (
    <div className="error" role="alert">
      Data unavailable — {error.message}. Previously loaded values are not live.
    </div>
  ) : null;
}
export function Terminal({
  page,
  initialProduct,
}: {
  page: string;
  initialProduct?: string;
}) {
  const s = useSettings(),
    client = useQueryClient();
  const setProduct = s.setProduct;
  const [search, setSearch] = useState(""),
    [grid, setGrid] = useState(false),
    [line, setLine] = useState(false),
    [clock, setClock] = useState("UTC");
  const market = useQuery({
    queryKey: ["markets"],
    queryFn: () => api<{ products: Product[] }>("/markets"),
    refetchInterval: 60000,
  });
  const all = market.data?.products || [];
  const product = all.find((p) => p.product_id === s.product);
  const feed = useFeed(s.product);
  const active = page === "dashboard" || page === "analysis";
  const candles = useQuery({
    queryKey: ["candles", s.product, s.frame],
    queryFn: () =>
      api<CandleResponse>(`/markets/${s.product}/candles?timeframe=${s.frame}`),
    enabled: active,
    refetchInterval: 30000,
  });
  const analysis = useQuery({
    queryKey: ["analysis", s.product, s.frame],
    queryFn: () => api<Analysis>(`/analysis/${s.product}?timeframe=${s.frame}`),
    enabled: active,
    refetchInterval: 60000,
  });
  const book = useQuery({
    queryKey: ["book", s.product],
    queryFn: () => api<Book>(`/markets/${s.product}/orderbook`),
    enabled: active,
    refetchInterval: 5000,
  });
  const multi = useQueries({
    queries: frames.map((frame) => ({
      queryKey: ["analysis", s.product, frame],
      queryFn: () => api<Analysis>(`/analysis/${s.product}?timeframe=${frame}`),
      enabled: active,
      staleTime: 60000,
    })),
  });
  const grids = useQueries({
    queries: frames.map((frame) => ({
      queryKey: ["candles", s.product, frame],
      queryFn: () =>
        api<CandleResponse>(`/markets/${s.product}/candles?timeframe=${frame}`),
      enabled: active && grid,
      staleTime: 30000,
    })),
  });
  useEffect(() => {
    if (initialProduct) setProduct(decodeURIComponent(initialProduct));
  }, [initialProduct, setProduct]);
  useEffect(() => {
    const id = setInterval(
      () => setClock(new Date().toISOString().slice(11, 19) + " UTC"),
      1000,
    );
    return () => clearInterval(id);
  }, []);
  const shown = search
    ? all
        .filter((p) => p.product_id.includes(search.toUpperCase()))
        .slice(0, 12)
    : s.watchlist
        .map((id) => all.find((p) => p.product_id === id))
        .filter((p): p is Product => !!p);
  const price = feed.price ?? (product ? Number(product.price) : undefined);
  const precision = product
    ? Math.max(2, Math.ceil(-Math.log10(Number(product.quote_increment))))
    : 4;
  const a = analysis.data;
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link href="/dashboard" className="brand">
          <div className="brand-icon">
            <Activity size={23} />
          </div>
          <span>
            COINBASE <b>QUANT PRO</b>
            <small>MARKET INTELLIGENCE</small>
          </span>
        </Link>
        <div className="top-right">
          <span className="read-only">
            <ShieldCheck size={13} /> SPOT · READ ONLY
          </span>
          <span className={"feed " + feed.status.toLowerCase()}>
            <i />
            {feed.status}
          </span>
          <span className="clock">{clock}</span>
          <Link href="/settings" aria-label="Settings">
            <SlidersHorizontal size={18} />
          </Link>
        </div>
      </header>
      <aside className="sidebar">
        <div className="side-label">WORKSPACE</div>
        <nav>
          {nav.map(([route, label, Icon]) => (
            <Link
              key={route}
              href={"/" + route}
              className={page === route ? "selected" : ""}
            >
              <Icon size={17} />
              {label}
              {page === route && <ChevronRight size={14} />}
            </Link>
          ))}
        </nav>
        <div className="watch-header">
          <span className="side-label">WATCHLIST</span>
          <span>{s.watchlist.length} / 20</span>
        </div>
        <label className="search">
          <Search size={14} />
          <input
            aria-label="Search spot markets"
            placeholder="Find a spot market"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <ErrorBox error={market.error} />
        {market.isPending && (
          <div className="muted pad">Discovering active spot markets…</div>
        )}
        <div className="watchlist">
          {shown.map((p) => (
            <button
              key={p.product_id}
              className={s.product === p.product_id ? "active" : ""}
              onClick={() => {
                s.add(p.product_id);
                setSearch("");
              }}
            >
              <span className={"coin coin-" + p.product_id.split("-")[0]}>
                {p.product_id.slice(0, 1)}
              </span>
              <span className="watch-name">
                {p.product_id.split("-")[0]}
                <small>{p.quote_currency_id}</small>
              </span>
              <span className="watch-price">
                {number(p.price, Number(p.price) < 10 ? 4 : 2)}
                <small
                  className={
                    Number(p.price_percentage_change_24h) >= 0
                      ? "positive"
                      : "negative"
                  }
                >
                  {Number(p.price_percentage_change_24h) >= 0 ? "+" : ""}
                  {number(p.price_percentage_change_24h)}%
                </small>
              </span>
            </button>
          ))}
        </div>
        <p className="side-note">
          Watchlist: REST snapshots.
          <br />
          Selected market: live stream.
          <br />
          Unavailable pairs are excluded.
        </p>
        <div className="side-bottom">
          <ShieldCheck size={20} />
          <strong>Research, not execution</strong>
          <p>
            No account access.
            <br />
            No real-money orders.
          </p>
        </div>
      </aside>
      <main>
        <div className="breadcrumb">
          Workspace <ChevronRight size={12} />{" "}
          {page === "dashboard" ? "Market overview" : page.replace("-", " ")}
          <span className="workspace-label">PUBLIC MARKET DATA</span>
        </div>
        {!active ? (
          <ResearchPages page={page} products={all} />
        ) : (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">YOUR EDGE STARTS WITH EVIDENCE</div>
                <h1>
                  {page === "analysis"
                    ? "Deep market analysis"
                    : "Market overview"}
                  <span className="beta">RESEARCH BETA</span>
                </h1>
                <p>Live markets. Transparent signals. Measured decisions.</p>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  client.invalidateQueries();
                }}
              >
                ↻ Refresh analysis
              </Button>
            </div>
            <section className="market-head panel">
              <div className="asset-title">
                <span className={"coin large coin-" + s.product.split("-")[0]}>
                  {s.product[0]}
                </span>
                <div>
                  <h2>
                    {s.product}
                    <span>SPOT</span>
                  </h2>
                  <small>
                    {product?.base_name || "Verifying market"} · Coinbase
                    Advanced
                  </small>
                </div>
              </div>
              <div className="main-price">
                <strong data-testid="market-price">
                  {number(price, precision)}
                </strong>
                <span>
                  {s.product.split("-")[1]} ·{" "}
                  {feed.status === "LIVE"
                    ? "stream price"
                    : "last observed, not live"}
                </span>
              </div>
              <div className="metric">
                <label>24H CHANGE</label>
                <strong
                  className={
                    Number(product?.price_percentage_change_24h) >= 0
                      ? "positive"
                      : "negative"
                  }
                >
                  {number(product?.price_percentage_change_24h)}%
                </strong>
              </div>
              <div className="metric">
                <label>24H BASE VOLUME</label>
                <strong>{number(product?.volume_24h, 0)}</strong>
              </div>
              <div className="metric">
                <label>PRICE UPDATED</label>
                <strong className="small-value">{stamp(feed.time)}</strong>
              </div>
            </section>
            <div className="data-source">
              <Radio size={12} />{" "}
              {feed.source
                ? `Coinbase stream: ${feed.source}${feed.source !== s.product ? " · exchange-mapped alias for " + s.product : ""}`
                : "Connecting to Coinbase public market stream"}
              <span>Indicators: {stamp(a?.calculated_at)}</span>
            </div>
            <ErrorBox error={candles.error || analysis.error} />
            <div className="chart-layout">
              <section className="panel chart-panel">
                <div className="chart-toolbar">
                  <div className="tabs">
                    {frames.map((f) => (
                      <button
                        key={f}
                        className={s.frame === f && !grid ? "active" : ""}
                        onClick={() => {
                          s.setFrame(f);
                          setGrid(false);
                        }}
                      >
                        {f}
                      </button>
                    ))}
                    <button
                      className={grid ? "active" : ""}
                      onClick={() => setGrid(!grid)}
                    >
                      ⊞ Multi
                    </button>
                  </div>
                  <div className="chart-kind">
                    <button onClick={() => setLine(!line)}>
                      {line ? "Line" : "Candles"}
                    </button>
                    <span>UTC</span>
                  </div>
                </div>
                <div className="overlays">
                  {[
                    "ema9",
                    "ema20",
                    "ema50",
                    "ema200",
                    "sma50",
                    "vwap",
                    "bb_upper",
                    "bb_lower",
                    "zones",
                  ].map((x) => (
                    <button
                      aria-pressed={s.overlays.includes(x)}
                      key={x}
                      onClick={() => s.toggle(x)}
                      className={s.overlays.includes(x) ? "on" : ""}
                    >
                      <i />
                      {(
                        {
                          zones: "S/R zones",
                          bb_upper: "BB upper",
                          bb_lower: "BB lower",
                        } as Record<string, string>
                      )[x] || x.toUpperCase()}
                    </button>
                  ))}
                </div>
                {grid ? (
                  <div className="grid-charts">
                    {grids.map((q, i) => (
                      <div key={frames[i]}>
                        <h3>{frames[i]}</h3>
                        <ErrorBox error={q.error} />
                        {q.data && (
                          <MarketChart
                            candles={q.data.candles}
                            analysis={multi[i].data}
                            overlays={s.overlays}
                            frame={frames[i]}
                            tickSize={product?.quote_increment}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                ) : candles.data ? (
                  <MarketChart
                    candles={candles.data.candles}
                    analysis={a}
                    overlays={s.overlays}
                    feed={feed}
                    frame={s.frame}
                    tickSize={product?.quote_increment}
                    line={line}
                  />
                ) : (
                  <div className="chart-loading">
                    <Activity size={28} />
                    <h3>Loading exchange candles</h3>
                    <p>Fetching and validating Coinbase historical data…</p>
                  </div>
                )}
              </section>
              <aside className="insights">
                <section className="panel decision">
                  <div className="panel-title">
                    <Zap size={15} />
                    <span>DECISION ENGINE</span>
                    <span className="tag">RULE BASED</span>
                  </div>
                  <div className="decision-state">
                    <span>WAIT</span>
                    <ShieldCheck size={27} />
                  </div>
                  <h3>Patience is a position.</h3>
                  <p>
                    {a?.signal.reason ||
                      "Waiting for validated completed-candle analysis."}
                  </p>
                  <div className="reason-list">
                    {a?.signal.evidence.map((e) => (
                      <div key={e}>
                        <i />
                        {e}
                      </div>
                    ))}
                  </div>
                  <div className="decision-footer">
                    No validated edge · no trade setup
                  </div>
                </section>
                <section className="panel book">
                  <div className="panel-title">
                    <Activity size={14} />
                    <span>ORDER BOOK</span>
                    <span className="tag">REST · 5S</span>
                  </div>
                  <ErrorBox error={book.error} />
                  <div className="book-label">
                    <span>Price</span>
                    <span>Base size</span>
                  </div>
                  {book.data?.asks
                    .slice(0, 4)
                    .reverse()
                    .map((r, i) => (
                      <div className="book-row negative" key={"a" + i}>
                        <span>{number(r.price, precision)}</span>
                        <span>{number(r.size, 2)}</span>
                      </div>
                    ))}
                  <div className="spread">
                    Spread <b>{number(book.data?.spread_bps, 2)} bps</b>
                  </div>
                  {book.data?.bids.slice(0, 4).map((r, i) => (
                    <div className="book-row positive" key={"b" + i}>
                      <span>{number(r.price, precision)}</span>
                      <span>{number(r.size, 2)}</span>
                    </div>
                  ))}
                  <small>
                    Snapshot {stamp(book.data?.timestamp)}
                    <br />
                    Displayed liquidity is not guaranteed execution.
                  </small>
                </section>
              </aside>
            </div>
            <section className="forecast panel">
              <div>
                <div className="panel-title">
                  <Blocks size={15} />
                  <span>FORECAST LAB</span>
                </div>
                <h3>Uncertainty, made visible.</h3>
                <p>
                  Probabilities appear only after out-of-sample calibration.
                </p>
              </div>
              {["1H", "4H", "24H", "7D"].map((h) => (
                <div className="forecast-cell" key={h}>
                  <label>{h} HORIZON</label>
                  <strong>
                    — <span>/ — / —</span>
                  </strong>
                  <small>UP / DOWN / SIDEWAYS</small>
                  <span className="model-state">NOT TRAINED</span>
                </div>
              ))}
            </section>
            <div className="lower-grid">
              <section className="panel">
                <div className="section-heading">
                  <h3>Multi-timeframe confluence</h3>
                  <span className="tag">COMPLETED CANDLES</span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Period</th>
                        <th>Trend</th>
                        <th>RSI</th>
                        <th>MACD Δ</th>
                        <th>Support</th>
                        <th>Resistance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {multi.map((q, i) => (
                        <tr key={frames[i]}>
                          <td>
                            <b>{frames[i]}</b>
                          </td>
                          <td>
                            <span
                              className={
                                "trend " +
                                (q.data?.trend === "Bullish"
                                  ? "positive"
                                  : "muted")
                              }
                            >
                              {q.isError
                                ? "Unavailable"
                                : q.data?.trend || "Loading"}
                            </span>
                          </td>
                          <td>{number(q.data?.indicators.rsi, 1)}</td>
                          <td>{number(q.data?.indicators.macd_hist, 4)}</td>
                          <td>
                            {number(
                              q.data?.zones.find((z) => z.type === "support")
                                ?.upper,
                              precision,
                            )}
                          </td>
                          <td>
                            {number(
                              q.data?.zones.find((z) => z.type === "resistance")
                                ?.lower,
                              precision,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="footnote">
                  Each timeframe is computed independently. Shared trend
                  indicators are not independent confirmations.
                </p>
                <Link className="text-link" href={"/analysis/" + s.product}>
                  Explore detailed analysis <ArrowUpRight size={14} />
                </Link>
              </section>
              <section className="panel">
                <div className="section-heading">
                  <h3>Key reaction zones</h3>
                  <span className="tag">{s.frame}</span>
                </div>
                {a?.zones.slice(0, 6).map((z, i) => (
                  <div className="zone" key={i}>
                    <div>
                      <span
                        className={z.type === "support" ? "positive" : "orange"}
                      >
                        {z.type.toUpperCase()}
                      </span>
                      <strong>
                        {number(z.lower, precision)} –{" "}
                        {number(z.upper, precision)}
                      </strong>
                    </div>
                    <div className="zone-strength">
                      <span>
                        {z.strength}
                        <small>/100</small>
                      </span>
                      <div>
                        <i
                          style={{
                            width: z.strength + "%",
                            background:
                              z.type === "support" ? "#24c8a0" : "#ee996b",
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
                {!a?.zones.length && (
                  <p className="pad muted">No validated zones available yet.</p>
                )}
                <p className="footnote">
                  Heuristic strength = touches (40) + recency (30) + pivot
                  volume (30). Not reversal probability. Candidate zones require
                  retest confirmation.
                </p>
              </section>
            </div>
            {page === "analysis" && (
              <section className="panel details">
                <h3>Indicator diagnostics · {s.frame}</h3>
                <p>
                  {a?.history_note}{" "}
                  {a?.discarded_before_gap
                    ? `${a.discarded_before_gap} older bars excluded after a historical gap.`
                    : ""}
                </p>
                {!!a?.warmup.length && (
                  <div className="notice">
                    Insufficient completed history for: {a.warmup.join(", ")}.
                    Values remain unavailable; no prices are filled in.
                  </div>
                )}
                <div className="indicator-grid">
                  {Object.entries(a?.indicators || {})
                    .filter(([k]) => k !== "time")
                    .map(([k, v]) => (
                      <div key={k}>
                        <label>{k.replaceAll("_", " ").toUpperCase()}</label>
                        <strong>{number(v, 4)}</strong>
                      </div>
                    ))}
                </div>
                <h3>Detected candle shapes</h3>
                {a?.patterns.length ? (
                  a.patterns.map((p) => (
                    <p key={p.name}>
                      {p.name} — {p.status}
                    </p>
                  ))
                ) : (
                  <p>
                    No matching completed-candle shapes. Advanced chart
                    formations are not implemented.
                  </p>
                )}
              </section>
            )}
            <div className="health-line">
              <ShieldCheck size={13} />
              <span>
                Data:{" "}
                {candles.isError
                  ? "UNAVAILABLE"
                  : candles.data?.quality || "LOADING"}{" "}
                · {a?.observations || 0} completed analysis candles · source
                candle{" "}
                {a ? new Date(a.source_candle * 1000).toISOString() : "—"}
              </span>
              <Link href="/models">
                Model diagnostics <ChevronRight size={12} />
              </Link>
            </div>
          </>
        )}
        <footer>
          Independent research application · not affiliated with Coinbase · No
          trading or transfer capability.
          <span>
            Forecasts are uncertain. Historical results do not guarantee future
            returns.
          </span>
        </footer>
      </main>
    </div>
  );
}
