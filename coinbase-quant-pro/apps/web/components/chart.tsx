"use client";
import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  BaselineSeries,
  ColorType,
  type UTCTimestamp,
  type ISeriesApi,
} from "lightweight-charts";
import type { Analysis, Candle, Frame } from "@/lib/api";
import type { Feed } from "@/hooks/use-feed";
import { number } from "@/lib/utils";

export function MarketChart({
  candles,
  analysis,
  overlays,
  feed,
  frame,
  tickSize = "0.0001",
  line = false,
}: {
  candles: Candle[];
  analysis?: Analysis;
  overlays: string[];
  feed?: Feed;
  frame: Frame;
  tickSize?: string;
  line?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const current = useRef<Candle | null>(null);
  const [hover, setHover] = useState("Move crosshair to inspect OHLC");
  useEffect(() => {
    if (!ref.current || !candles.length) return;
    const chart = createChart(ref.current, {
      height: 510,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0d1524" },
        textColor: "#8292ac",
        fontFamily: "Arial",
        fontSize: 11,
        panes: { separatorColor: "#263046", separatorHoverColor: "#4b5e7d" },
      },
      grid: {
        vertLines: { color: "#152034" },
        horzLines: { color: "#192237" },
      },
      timeScale: {
        timeVisible: frame === "1H" || frame === "4H",
        borderColor: "#253047",
      },
      rightPriceScale: { borderColor: "#253047" },
      crosshair: {
        vertLine: { color: "#65728b" },
        horzLine: { color: "#65728b" },
      },
    });
    const precision = Math.max(0, Math.ceil(-Math.log10(Number(tickSize))));
    const main = chart.addSeries(CandlestickSeries, {
      upColor: "#23c9a0",
      downColor: "#f36b83",
      borderVisible: false,
      wickUpColor: "#23c9a0",
      wickDownColor: "#f36b83",
      visible: !line,
      priceFormat: { type: "price", precision, minMove: Number(tickSize) },
    });
    main.setData(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    if (line)
      chart
        .addSeries(LineSeries, { color: "#5b91ff", lineWidth: 2 })
        .setData(
          candles.map((c) => ({
            time: c.time as UTCTimestamp,
            value: c.close,
          })),
        );
    seriesRef.current = main;
    current.current = candles[candles.length - 1];
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    volume
      .priceScale()
      .applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    volume.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? "#1d5f58" : "#623747",
      })),
    );
    const palette: Record<string, string> = {
      ema9: "#f4ce77",
      ema20: "#5697ff",
      ema50: "#bd86ff",
      ema200: "#ec9c5c",
      sma50: "#d3cfa7",
      vwap: "#52d2df",
      bb_upper: "#7891b2",
      bb_lower: "#7891b2",
    };
    for (const key of overlays)
      if (palette[key] && analysis) {
        chart
          .addSeries(LineSeries, {
            color: palette[key],
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
          })
          .setData(
            analysis.series
              .filter((r) => r[key] != null)
              .map((r) => ({
                time: r.time as UTCTimestamp,
                value: r[key] as number,
              })),
          );
      }
    if (overlays.includes("zones") && analysis)
      for (const zone of analysis.zones) {
        const color = zone.type === "support" ? "#27c8a0" : "#f19468";
        const band = chart.addSeries(BaselineSeries, {
          baseValue: { type: "price", price: zone.lower },
          topLineColor: color,
          topFillColor1: color + "16",
          topFillColor2: color + "16",
          bottomLineColor: color,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          autoscaleInfoProvider: () => null,
        });
        band.setData([
          { time: candles[0].time as UTCTimestamp, value: zone.upper },
          {
            time: candles[candles.length - 1].time as UTCTimestamp,
            value: zone.upper,
          },
        ]);
        main.createPriceLine({
          price: zone.lower,
          color: color + "88",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: false,
          title: "",
        });
      }
    if (analysis) {
      const rsi = chart.addSeries(
        LineSeries,
        {
          color: "#c497f5",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
        },
        1,
      );
      rsi.setData(
        analysis.series
          .filter((r) => r.rsi != null)
          .map((r) => ({ time: r.time as UTCTimestamp, value: r.rsi! })),
      );
      for (const p of [30, 70])
        rsi.createPriceLine({
          price: p,
          color: "#47516c",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "",
        });
      chart
        .addSeries(
          HistogramSeries,
          { priceLineVisible: false, lastValueVisible: false },
          2,
        )
        .setData(
          analysis.series
            .filter((r) => r.macd_hist != null)
            .map((r) => ({
              time: r.time as UTCTimestamp,
              value: r.macd_hist!,
              color: r.macd_hist! >= 0 ? "#268c79" : "#a14e63",
            })),
        );
      chart.panes()[0].setHeight(340);
      chart.panes()[1].setHeight(85);
      chart.panes()[2].setHeight(85);
    }
    chart.subscribeCrosshairMove((p) => {
      const bar = p.seriesData.get(main);
      if (bar && "open" in bar)
        setHover(
          `O ${number(bar.open, precision)}   H ${number(bar.high, precision)}   L ${number(bar.low, precision)}   C ${number(bar.close, precision)}`,
        );
    });
    chart
      .timeScale()
      .setVisibleLogicalRange({
        from: Math.max(0, candles.length - 130),
        to: candles.length + 8,
      });
    return () => {
      seriesRef.current = null;
      chart.remove();
    };
  }, [candles, analysis, overlays, frame, tickSize, line]);
  useEffect(() => {
    if (
      !feed?.price ||
      feed.status !== "LIVE" ||
      !seriesRef.current ||
      !current.current
    )
      return;
    const seconds = { "1H": 3600, "4H": 14400, "1D": 86400, "1W": 604800 }[
      frame
    ];
    const at = Date.parse(feed.time!) / 1000;
    const c = current.current;
    // Only update the open bar; REST supplies authoritative new bars and volume.
    if (!c.complete && at >= c.time && at < c.time + seconds) {
      current.current = {
        ...c,
        close: feed.price,
        high: Math.max(c.high, feed.price),
        low: Math.min(c.low, feed.price),
      };
      seriesRef.current.update({
        ...current.current,
        time: c.time as UTCTimestamp,
      });
    }
  }, [feed, frame]);
  return (
    <div className="chart-wrap">
      <div className="ohlc">
        {hover}
        <span>RSI 14 / MACD 12·26·9 · completed bars</span>
      </div>
      <div ref={ref} className="chart" data-testid="candle-chart" />
      <div className="chart-note">
        {candles.length} exchange candles · open candle is provisional ·{" "}
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          Charts by TradingView
        </a>
      </div>
    </div>
  );
}
