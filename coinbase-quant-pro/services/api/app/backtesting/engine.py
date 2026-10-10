"""Long-only next-open bar simulation. Stops win ambiguous bars; no shorting."""

from decimal import Decimal as D
from typing import Literal

import numpy as np
from pydantic import BaseModel, Field, model_validator

from app.indicators.core import calculate


class BacktestInput(BaseModel):
    product: str = Field(default="XRP-USDC", pattern=r"^[A-Z0-9]+-[A-Z0-9]+$")
    timeframe: Literal["1H", "4H", "1D"] = "1H"
    strategy: Literal["ema", "rsi", "breakout"] = "ema"
    bars: int = Field(default=700, ge=250, le=2000)
    end: int | None = Field(default=None, gt=0)
    capital: float = Field(default=10000, gt=0, le=1e8)
    fee_pct: float = Field(default=0.6, ge=0, le=5)
    slippage_pct: float = Field(default=0.05, ge=0, le=5)
    risk_pct: float = Field(default=1, gt=0, le=5)
    stop_pct: float = Field(default=2, gt=0.1, le=30)
    target_pct: float = Field(default=4, gt=0.1, le=100)

    @model_validator(mode="after")
    def finite_values(self):
        if not all(
            np.isfinite(v)
            for v in (
                self.capital,
                self.fee_pct,
                self.slippage_pct,
                self.risk_pct,
                self.stop_pct,
                self.target_pct,
            )
        ):
            raise ValueError("Inputs must be finite")
        return self


def run(candles, config):
    rows = [c for c in candles if c["complete"]]
    if len(rows) < 201:
        raise ValueError("At least 201 completed candles required")
    indicators = calculate(rows)
    cash = D(str(config.capital))
    fee, slip = D(str(config.fee_pct)) / 100, D(str(config.slippage_pct)) / 100
    qty, position = D(0), None
    trades, curve = [], []
    peak = float(cash)
    exposed = 0
    for i in range(200, len(rows)):
        row, prev, prior = rows[i], indicators.iloc[i - 1], indicators.iloc[i - 2]
        buy = prev.ema20 > prev.ema50 and prior.ema20 <= prior.ema50
        sell = prev.ema20 < prev.ema50
        if config.strategy == "rsi":
            buy, sell = prev.rsi < 30, prev.rsi > 60
        if config.strategy == "breakout":
            # The decision is made at i-1 close against highs strictly before i-1.
            buy = (
                rows[i - 1]["close"] > max(r["high"] for r in rows[i - 21 : i - 1])
                and prev.relative_volume > 1.5
            )
            sell = prev.rsi < 45
        if qty == 0 and buy:
            entry = D(str(row["open"])) * (1 + slip)
            stop = entry * (1 - D(str(config.stop_pct)) / 100)
            target = entry * (1 + D(str(config.target_pct)) / 100)
            risk_per_unit = entry * (1 + fee) - stop * (1 - slip) * (1 - fee)
            qty = min(
                cash / (entry * (1 + fee)), cash * D(str(config.risk_pct)) / 100 / risk_per_unit
            )
            cost = qty * entry * (1 + fee)
            cash -= cost
            position = {
                "entry_time": row["time"],
                "entry": entry,
                "stop": stop,
                "target": target,
                "cost": cost,
                "entry_fee": qty * entry * fee,
                "entry_slippage": qty * D(str(row["open"])) * slip,
            }
        if qty:
            exposed += 1
            raw_exit, reason = None, None
            if sell and position["entry_time"] != row["time"]:
                raw_exit, reason = D(str(row["open"])), "signal at prior close"
            elif D(str(row["low"])) <= position["stop"]:
                raw_exit, reason = (
                    min(D(str(row["open"])), position["stop"]),
                    "stop (first if ambiguous)",
                )
            elif D(str(row["high"])) >= position["target"]:
                raw_exit, reason = position["target"], "target"
            elif i == len(rows) - 1:
                raw_exit, reason = D(str(row["close"])), "end-of-test liquidation"
            if raw_exit is not None:
                exit_price = raw_exit * (1 - slip)
                proceeds = qty * exit_price * (1 - fee)
                cash += proceeds
                trades.append(
                    {
                        "entry_time": position["entry_time"],
                        "exit_time": row["time"],
                        "entry": float(position["entry"]),
                        "exit": float(exit_price),
                        "quantity": float(qty),
                        "net_pnl": float(proceeds - position["cost"]),
                        "fees": float(position["entry_fee"] + qty * exit_price * fee),
                        "slippage_cost": float(position["entry_slippage"] + qty * raw_exit * slip),
                        "reason": reason,
                    }
                )
                qty, position = D(0), None
        equity = float(cash + qty * D(str(row["close"])) * (1 - fee) * (1 - slip))
        peak = max(peak, equity)
        curve.append({"time": row["time"], "equity": equity, "drawdown": (equity / peak - 1) * 100})
    wins = [t["net_pnl"] for t in trades if t["net_pnl"] > 0]
    losses = [t["net_pnl"] for t in trades if t["net_pnl"] <= 0]
    changes = np.diff([config.capital] + [c["equity"] for c in curve]) / np.array(
        [config.capital] + [c["equity"] for c in curve[:-1]]
    )
    annual = {"1H": 8760, "4H": 2190, "1D": 365}[config.timeframe]
    benchmark = (
        rows[-1]["close"]
        * (1 - float(slip))
        * (1 - float(fee))
        / (rows[200]["open"] * (1 + float(slip)) * (1 + float(fee)))
        - 1
    ) * 100
    return {
        "status": "complete",
        "strategy": config.strategy,
        "evaluation": "In-sample historical simulation; not out-of-sample validation",
        "metrics": {
            "total_return_pct": (float(cash) / config.capital - 1) * 100,
            "net_pnl": float(cash) - config.capital,
            "trade_count": len(trades),
            "win_rate": len(wins) / len(trades) * 100 if trades else None,
            "average_gain": float(np.mean(wins)) if wins else None,
            "average_loss": float(np.mean(losses)) if losses else None,
            "profit_factor": sum(wins) / abs(sum(losses)) if sum(losses) else None,
            "expectancy": sum(t["net_pnl"] for t in trades) / len(trades) if trades else None,
            "sharpe": float(np.mean(changes) / np.std(changes) * np.sqrt(annual))
            if np.std(changes) > 0
            else None,
            "max_drawdown_pct": min(c["drawdown"] for c in curve),
            "exposure_pct": exposed / len(curve) * 100,
            "fees": sum(t["fees"] for t in trades),
            "slippage_cost": sum(t["slippage_cost"] for t in trades),
            "buy_hold_pct": benchmark,
        },
        "equity": curve,
        "trades": trades,
        "assumptions": "200-bar warmup; next-open market fills; full fills; no leverage; stop-first ambiguous bars; fees and adverse slippage both sides. No limit-fill or partial-fill claims.",
    }
