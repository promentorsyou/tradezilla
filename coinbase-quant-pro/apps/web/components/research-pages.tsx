"use client";
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  LineChart,
  Line,
} from "recharts";
import { api, type Product } from "@/lib/api";
import { useSettings } from "@/lib/store";
import { number, stamp } from "@/lib/utils";
import { Button } from "./ui/button";

type Result = {
  status: string;
  detail?: string;
  metrics: Record<string, number | null>;
  equity: { time: number; equity: number; drawdown: number }[];
  trades: {
    entry_time: number;
    exit_time: number;
    entry: number;
    exit: number;
    net_pnl: number;
    fees: number;
    reason: string;
  }[];
  assumptions: string;
  evaluation: string;
};
function Heading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">COINBASE QUANT PRO / RESEARCH WORKSPACE</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
    </div>
  );
}
function Failure({ error }: { error: Error | null }) {
  return error ? (
    <div className="error" role="alert">
      {error.message}
    </div>
  ) : null;
}
export function ResearchPages({
  page,
  products,
}: {
  page: string;
  products: Product[];
}) {
  if (page === "backtesting") return <Backtesting />;
  if (page === "settings") return <Settings />;
  if (page === "models") return <Models />;
  if (page === "signals") return <Signals />;
  return <Markets products={products} />;
}
function Markets({ products }: { products: Product[] }) {
  const [filter, setFilter] = useState(""),
    [sort, setSort] = useState("volume");
  const rows = products
    .filter((p) => p.product_id.includes(filter.toUpperCase()))
    .sort((a, b) =>
      sort === "change"
        ? Number(b.price_percentage_change_24h) -
          Number(a.price_percentage_change_24h)
        : Number(b.price) * Number(b.volume_24h) -
          Number(a.price) * Number(a.volume_24h),
    );
  return (
    <>
      <Heading
        title="Market scanner"
        description="Discover verified active Coinbase spot markets. Prices are timestamped REST snapshots."
      />
      <div className="panel details">
        <div className="form-inline">
          <input
            aria-label="Filter markets"
            placeholder="Search asset or quote currency"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            aria-label="Sort markets"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="volume">Quote volume</option>
            <option value="change">24H change</option>
          </select>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Spot market</th>
                <th>Price</th>
                <th>24H change</th>
                <th>Base volume</th>
                <th>Analysis</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 150).map((p) => (
                <tr key={p.product_id}>
                  <td>
                    <b>{p.product_id}</b>
                    <small className="block muted">{p.base_name}</small>
                  </td>
                  <td>{number(p.price, Number(p.price) < 10 ? 6 : 2)}</td>
                  <td
                    className={
                      Number(p.price_percentage_change_24h) >= 0
                        ? "positive"
                        : "negative"
                    }
                  >
                    {number(p.price_percentage_change_24h)}%
                  </td>
                  <td>{number(p.volume_24h, 0)}</td>
                  <td>
                    <Link
                      className="text-link"
                      href={"/analysis/" + p.product_id}
                    >
                      Open analysis ↗
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="footnote">
          Showing up to 150 of {rows.length} matches. Multi-timeframe technical
          signals are calculated on the individual analysis page, not
          precomputed for this scanner.
        </p>
      </div>
    </>
  );
}
function Backtesting() {
  const s = useSettings();
  const [strategy, setStrategy] = useState("ema"),
    [bars, setBars] = useState(700),
    [job, setJob] = useState<string>(),
    [capital, setCapital] = useState(10000),
    [end, setEnd] = useState("");
  const start = useMutation({
    mutationFn: () =>
      api<{ job_id: string }>("/backtests", {
        product: s.product,
        timeframe: s.frame === "1W" ? "1D" : s.frame,
        strategy,
        bars,
        capital,
        fee_pct: s.fee,
        slippage_pct: s.slippage,
        end: end ? Math.floor(Date.parse(end + "T23:59:59Z") / 1000) : null,
      }),
    onSuccess: (r) => setJob(r.job_id),
  });
  const result = useQuery({
    queryKey: ["backtest", job],
    queryFn: () => api<Result>("/backtests/" + job),
    enabled: !!job,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1000 : false),
  });
  const r = result.data;
  return (
    <>
      <Heading
        title="Strategy backtesting"
        description="Real exchange history. Conservative execution. Every winning and losing trade."
      />
      <section className="panel details">
        <div className="notice">
          Historical simulation only—not out-of-sample evidence or a
          profitability claim. {s.product} · {s.frame === "1W" ? "1D" : s.frame}
        </div>
        <div className="form-grid">
          <label>
            Strategy
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
            >
              <option value="ema">EMA 20/50 crossover</option>
              <option value="rsi">RSI mean reversion</option>
              <option value="breakout">Breakout + volume</option>
            </select>
          </label>
          <label>
            History bars (200 warmup)
            <input
              type="number"
              min="250"
              max="2000"
              value={bars}
              onChange={(e) => setBars(Number(e.target.value))}
            />
          </label>
          <label>
            Ending date (UTC; optional)
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <label>
            Hypothetical starting cash
            <input
              type="number"
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value))}
            />
          </label>
          <label>
            Fee per side (%)
            <input
              type="number"
              step="0.01"
              min="0"
              max="5"
              value={s.fee}
              onChange={(e) => s.setFee(Number(e.target.value))}
            />
          </label>
          <label>
            Slippage per side (%)
            <input
              type="number"
              step="0.01"
              min="0"
              max="5"
              value={s.slippage}
              onChange={(e) => s.setSlippage(Number(e.target.value))}
            />
          </label>
        </div>
        <p className="footnote">
          Risk: 1% of equity · stop: 2% · target: 4% · no leverage · next-bar
          open entries. Fees are user assumptions, not verified Coinbase account
          rates.
        </p>
        <Button
          onClick={() => start.mutate()}
          disabled={start.isPending || r?.status === "running"}
        >
          {start.isPending || r?.status === "running"
            ? "Running historical simulation…"
            : "Run backtest"}
        </Button>
        <Failure error={start.error || result.error} />
        {r?.status === "failed" && <div className="error">{r.detail}</div>}
      </section>
      {r?.status === "complete" && (
        <>
          <div className="stats-grid">
            {Object.entries(r.metrics).map(([k, v]) => (
              <div className="panel metric-card" key={k}>
                <label>{k.replaceAll("_", " ").toUpperCase()}</label>
                <strong>{number(v, k === "trade_count" ? 0 : 2)}</strong>
              </div>
            ))}
          </div>
          <div className="panel details">
            <h3>Portfolio equity</h3>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={r.equity}>
                <defs>
                  <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#638dff" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#638dff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#202c43" vertical={false} />
                <XAxis
                  dataKey="time"
                  tickFormatter={(v) =>
                    new Date(v * 1000).toISOString().slice(5, 10)
                  }
                />
                <YAxis domain={["auto", "auto"]} />
                <Tooltip
                  labelFormatter={(v) =>
                    new Date(Number(v) * 1000).toISOString()
                  }
                />
                <Area dataKey="equity" stroke="#638dff" fill="url(#eq)" />
              </AreaChart>
            </ResponsiveContainer>
            <h3>Drawdown (%)</h3>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={r.equity}>
                <YAxis />
                <Tooltip />
                <Line dataKey="drawdown" stroke="#f36b83" dot={false} />
              </LineChart>
            </ResponsiveContainer>
            <p className="footnote">{r.assumptions}</p>
          </div>
          <section className="panel details">
            <h3>All simulated trades · {r.trades.length}</h3>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Entry UTC</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Net P/L</th>
                    <th>Fees</th>
                    <th>Exit reason</th>
                  </tr>
                </thead>
                <tbody>
                  {r.trades.map((t, i) => (
                    <tr key={i}>
                      <td>
                        {new Date(t.entry_time * 1000)
                          .toISOString()
                          .slice(0, 16)}
                      </td>
                      <td>{number(t.entry, 4)}</td>
                      <td>{number(t.exit, 4)}</td>
                      <td className={t.net_pnl >= 0 ? "positive" : "negative"}>
                        {number(t.net_pnl)}
                      </td>
                      <td>{number(t.fees)}</td>
                      <td>{t.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!r.trades.length && (
              <p>
                No strategy entries occurred in this history. No trades were
                fabricated.
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
}
function Models() {
  const q = useQuery({
    queryKey: ["models"],
    queryFn: () =>
      api<{ models: { name: string; status: string }[]; reason: string }>(
        "/models",
      ),
  });
  return (
    <>
      <Heading
        title="Model registry"
        description="An honest view of model readiness. No training means no predictive probability."
      />
      <Failure error={q.error} />
      <div className="notice">
        {q.data?.reason || "Loading model registry…"}
      </div>
      <div className="model-grid">
        {q.data?.models.map((m) => (
          <section className="panel details" key={m.name}>
            <span className="model-state">{m.status}</span>
            <h3>{m.name}</h3>
            <p>
              Validation period, Brier score, calibration, directional accuracy
              and forecast errors: unavailable.
            </p>
            <div className="empty-metric">
              —<small>No evaluated artifact</small>
            </div>
          </section>
        ))}
      </div>
      <section className="panel details">
        <h3>Promotion gate</h3>
        <p>
          Chronological training → purged walk-forward validation → separate
          calibration → untouched evaluation → acceptance thresholds. This
          pipeline remains to be implemented; models cannot influence
          recommendations yet.
        </p>
      </section>
    </>
  );
}
function Signals() {
  const q = useQuery({
    queryKey: ["signals"],
    queryFn: () =>
      api<{
        records: {
          id: string;
          created_at: string;
          product: string;
          timeframe: string;
          price: number;
          signal: { state: string; reason: string };
        }[];
      }>("/signals/history"),
  });
  return (
    <>
      <Heading
        title="Signal journal"
        description="Append-only analytical observations. No historical recommendations are rewritten."
      />
      <Failure error={q.error} />
      <section className="panel details">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Generated UTC</th>
                <th>Market</th>
                <th>Frame</th>
                <th>Observed close</th>
                <th>State</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.records.map((r) => (
                <tr key={r.id}>
                  <td>{stamp(r.created_at)}</td>
                  <td>{r.product}</td>
                  <td>{r.timeframe}</td>
                  <td>{number(r.price, 4)}</td>
                  <td>
                    <span className="tag">{r.signal.state}</span>
                  </td>
                  <td>{r.signal.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!q.data?.records.length && (
          <p>
            No observations recorded yet. Open an analysis page to calculate a
            completed-candle snapshot.
          </p>
        )}
        <p className="footnote">
          Outcome scoring and tamper-resistant database policies remain future
          work. The application exposes no signal-edit or delete endpoint.
        </p>
      </section>
    </>
  );
}
function Settings() {
  const s = useSettings();
  const [entry, setEntry] = useState(""),
    [exit, setExit] = useState(""),
    [stop, setStop] = useState(""),
    [amount, setAmount] = useState(1000);
  const calc = useMutation({
    mutationFn: () =>
      api<Record<string, string>>("/risk/calculate", {
        entry,
        exit,
        stop,
        amount,
        entry_fee_pct: s.fee,
        exit_fee_pct: s.fee,
        slippage_pct: s.slippage,
      }),
  });
  const health = useQuery({
    queryKey: ["system"],
    queryFn: () =>
      api<{ last_coinbase_success: string; mode: string }>("/system/status"),
  });
  return (
    <>
      <Heading
        title="Settings & risk lab"
        description="Local preferences and hypothetical execution costs. No account connection required."
      />
      <section className="panel details">
        <h3>Research assumptions</h3>
        <div className="form-grid">
          <label>
            Default timeframe
            <select
              value={s.frame}
              onChange={(e) => s.setFrame(e.target.value as typeof s.frame)}
            >
              {["1H", "4H", "1D", "1W"].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label>
            Fee per side (%)
            <input
              type="number"
              min="0"
              max="5"
              step="0.01"
              value={s.fee}
              onChange={(e) => s.setFee(Number(e.target.value))}
            />
          </label>
          <label>
            Slippage per side (%)
            <input
              type="number"
              min="0"
              max="5"
              step="0.01"
              value={s.slippage}
              onChange={(e) => s.setSlippage(Number(e.target.value))}
            />
          </label>
        </div>
        <p className="notice">
          Fees are illustrative assumptions—not your verified Coinbase tier.
          Maker-style post-only limits are not guaranteed to fill.
        </p>
        <h3>Watchlist</h3>
        <div className="chips">
          {s.watchlist.map((p) => (
            <button
              key={p}
              onClick={() => s.remove(p)}
              aria-label={"Remove " + p}
            >
              {p} ×
            </button>
          ))}
        </div>
        <p className="footnote">
          Search in the sidebar to add verified markets. Preferences are saved
          in this browser.
        </p>
      </section>
      <section className="panel details">
        <h3>Hypothetical fee-adjusted trade</h3>
        <p>Enter your own scenario. These are not recommended trade levels.</p>
        <div className="form-grid">
          <label>
            Entry price
            <input
              aria-label="Entry price"
              type="number"
              step="any"
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
            />
          </label>
          <label>
            Exit / target price
            <input
              aria-label="Exit price"
              type="number"
              step="any"
              value={exit}
              onChange={(e) => setExit(e.target.value)}
            />
          </label>
          <label>
            Stop price
            <input
              aria-label="Stop price"
              type="number"
              step="any"
              value={stop}
              onChange={(e) => setStop(e.target.value)}
            />
          </label>
          <label>
            Quote notional
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </label>
        </div>
        <Button
          onClick={() => calc.mutate()}
          disabled={!entry || !exit || !stop || calc.isPending}
        >
          Calculate net risk / reward
        </Button>
        <Failure error={calc.error} />
        {calc.data && (
          <div className="indicator-grid">
            {Object.entries(calc.data)
              .filter(([k]) => k !== "assumptions")
              .map(([k, v]) => (
                <div key={k}>
                  <label>{k.replaceAll("_", " ").toUpperCase()}</label>
                  <strong>{number(v, 4)}</strong>
                </div>
              ))}
          </div>
        )}
      </section>
      <section className="panel details">
        <h3>System diagnostics</h3>
        <Failure error={health.error} />
        <p>
          API: {health.data?.mode || "Unavailable"} · Last successful Coinbase
          REST request: {stamp(health.data?.last_coinbase_success)}
        </p>
        <p>
          Public market data only. No credentials stored. No order execution
          endpoints.
        </p>
      </section>
    </>
  );
}
