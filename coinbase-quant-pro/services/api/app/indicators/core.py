"""Causal indicators. Null during warmup; no backfill of future observations."""

import numpy as np
import pandas as pd


def wilder(s, n=14):
    # SMA seed followed by Wilder smoothing, not pandas' first-observation seed.
    result = pd.Series(np.nan, index=s.index, dtype=float)
    valid = s.dropna()
    if len(valid) < n:
        return result
    start = s.index.get_loc(valid.index[n - 1])
    result.iloc[start] = valid.iloc[:n].mean()
    for i in range(start + 1, len(s)):
        result.iloc[i] = (result.iloc[i - 1] * (n - 1) + s.iloc[i]) / n
    return result


def calculate(candles):
    d = pd.DataFrame(candles)
    if d.empty:
        return d
    c, h, low, v = d.close, d.high, d.low, d.volume
    out = pd.DataFrame({"time": d.time})
    for n in (9, 20, 50, 100, 200):
        out[f"ema{n}"] = c.ewm(span=n, adjust=False, min_periods=n).mean()
    for n in (20, 50, 200):
        out[f"sma{n}"] = c.rolling(n).mean()
    delta = c.diff()
    gain, loss = wilder(delta.clip(lower=0)), wilder(-delta.clip(upper=0))
    out["rsi"] = 100 - 100 / (1 + gain / loss)
    out.loc[(loss == 0) & (gain > 0), "rsi"] = 100
    out.loc[(loss == 0) & (gain == 0), "rsi"] = 50
    out["macd"] = (
        c.ewm(span=12, adjust=False, min_periods=12).mean()
        - c.ewm(span=26, adjust=False, min_periods=26).mean()
    )
    out["macd_signal"] = out.macd.ewm(span=9, adjust=False, min_periods=9).mean()
    out["macd_hist"] = out.macd - out.macd_signal
    tr = pd.concat([h - low, (h - c.shift()).abs(), (low - c.shift()).abs()], axis=1).max(axis=1)
    out["atr"] = wilder(tr)
    out["bb_upper"] = out.sma20 + 2 * c.rolling(20).std(ddof=0)
    out["bb_lower"] = out.sma20 - 2 * c.rolling(20).std(ddof=0)
    out["keltner_upper"] = out.ema20 + 2 * out.atr
    out["keltner_lower"] = out.ema20 - 2 * out.atr
    out["donchian_upper"], out["donchian_lower"] = h.rolling(20).max(), low.rolling(20).min()
    out["stochastic"] = (
        100
        * (c - low.rolling(14).min())
        / (h.rolling(14).max() - low.rolling(14).min()).replace(0, np.nan)
    )
    out["stoch_rsi"] = (
        100
        * (out.rsi - out.rsi.rolling(14).min())
        / (out.rsi.rolling(14).max() - out.rsi.rolling(14).min()).replace(0, np.nan)
    )
    typical = (h + low + c) / 3
    out["cci"] = (typical - typical.rolling(20).mean()) / (
        0.015 * typical.rolling(20).apply(lambda a: np.abs(a - a.mean()).mean(), raw=True)
    ).replace(0, np.nan)
    out["roc"] = c.pct_change(12) * 100
    out["historical_volatility"] = (
        np.log(c / c.shift()).rolling(20).std()
    )  # per-bar, not annualized
    out["obv"] = (np.sign(delta).fillna(0) * v).cumsum()
    out["cmf"] = (((2 * c - h - low) / (h - low).replace(0, np.nan)).fillna(0) * v).rolling(
        20
    ).sum() / v.rolling(20).sum().replace(0, np.nan)
    flow = typical * v
    positive = flow.where(typical.diff() > 0, 0).rolling(14).sum()
    negative = flow.where(typical.diff() < 0, 0).rolling(14).sum()
    out["mfi"] = 100 - 100 / (1 + positive / negative.replace(0, np.nan))
    out["relative_volume"] = v / v.shift().rolling(20).mean().replace(0, np.nan)
    # UTC daily session anchor; for daily/weekly bars equals typical price, not tick VWAP.
    day = d.time // 86400
    out["vwap"] = (typical * v).groupby(day).cumsum() / v.groupby(day).cumsum().replace(0, np.nan)
    up, down = h.diff(), -low.diff()
    plus = wilder(up.where((up > down) & (up > 0), 0)) / out.atr * 100
    minus = wilder(down.where((down > up) & (down > 0), 0)) / out.atr * 100
    out["adx"] = wilder(100 * (plus - minus).abs() / (plus + minus).replace(0, np.nan))
    out["ichimoku_tenkan"] = (h.rolling(9).max() + low.rolling(9).min()) / 2
    out["ichimoku_kijun"] = (h.rolling(26).max() + low.rolling(26).min()) / 2
    out["ichimoku_a"] = ((out.ichimoku_tenkan + out.ichimoku_kijun) / 2).shift(26)
    out["ichimoku_b"] = ((h.rolling(52).max() + low.rolling(52).min()) / 2).shift(26)
    return out.replace([np.inf, -np.inf], np.nan)


def records(frame):
    return frame.astype(object).where(pd.notnull(frame), None).to_dict("records")
