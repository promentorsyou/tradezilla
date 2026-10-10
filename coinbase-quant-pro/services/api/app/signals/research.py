"""Offline, chronological research only. Models are never execution approval.

No order-book features are invented from present-day books. Calibration is
disjoint from training; each split is purged by the maximum label horizon.
"""

import hashlib
import warnings
from pathlib import Path
import joblib

import numpy as np
from sklearn.calibration import CalibratedClassifierCV, calibration_curve
from sklearn.ensemble import RandomForestClassifier
from sklearn.frozen import FrozenEstimator
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss, precision_recall_fscore_support
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from lightgbm import LGBMClassifier

from app.indicators.core import calculate
from app.backtesting.engine import barrier_outcome, summarize_outcomes
from app.signals.decision_engine import candidates

FEATURES = [
    "return1",
    "return3",
    "atr_pct",
    "ema_slope",
    "rsi",
    "macd",
    "relative_volume",
    "bb_width",
    "distance_mean",
    "distance_support",
    "distance_resistance",
    "volatility",
    "trend",
]


def splits(n, horizon):
    a, b, c = int(n * 0.5), int(n * 0.65), int(n * 0.8)
    return {
        "train": (0, a - horizon),
        "select": (a, b - horizon),
        "calibrate": (b, c - horizon),
        "test": (c, n),
    }


def features(rows):
    frame = calculate([{**r, "complete": True} for r in rows])
    close = np.array([r["close"] for r in rows])
    log = np.log(close)
    x = []
    for i in range(len(rows)):
        r = frame.iloc[i]
        window = rows[max(0, i - 20) : i + 1]
        x.append(
            [
                log[i] - log[max(0, i - 1)],
                log[i] - log[max(0, i - 3)],
                r.atr / close[i],
                (r.ema20 - frame.iloc[max(0, i - 3)].ema20) / close[i],
                r.rsi / 100,
                r.macd_hist / close[i],
                r.relative_volume,
                (r.bb_upper - r.bb_lower) / close[i],
                (close[i] - r.ema20) / close[i],
                (close[i] - min(v["low"] for v in window)) / close[i],
                (max(v["high"] for v in window) - close[i]) / close[i],
                np.std(np.diff(log[max(0, i - 20) : i + 1])) if i else 0,
                (r.ema20 - r.ema50) / close[i],
            ]
        )
    return np.asarray(x), frame


def predict_metrics(y, prob):
    if (
        prob.shape != (len(y), 3)
        or not np.isfinite(prob).all()
        or not np.allclose(prob.sum(axis=1), 1)
    ):
        raise ValueError("Invalid calibrated probability matrix")
    pred = prob.argmax(axis=1)
    precision, recall, _, _ = precision_recall_fscore_support(
        y, pred, labels=[0, 1, 2], zero_division=0
    )
    observed, forecast = calibration_curve(y == 2, prob[:, 2], n_bins=5, strategy="quantile")
    return {
        "brier": float(np.mean(np.sum((prob - np.eye(3)[y]) ** 2, axis=1))),
        "log_loss": float(log_loss(y, prob, labels=[0, 1, 2])),
        "precision": precision.tolist(),
        "recall": recall.tolist(),
        "target_calibration": {"forecast": forecast.tolist(), "observed": observed.tolist()},
    }


def evaluate(rows, product, artifact_dir=None):
    x, ind = features(rows)
    n = len(rows)
    output = []
    version = hashlib.sha256((product + str(rows[-1]["time"]) + "research-1").encode()).hexdigest()[
        :12
    ]
    for minutes in (15, 60, 240, 1440):
        h = minutes // 5
        data = []
        for i in range(200, n - h - 1):
            if not np.isfinite(x[i]).all():
                continue
            # Candidate-specific ATR barriers fixed at decision close; next-open fills.
            atr = float(ind.iloc[i].atr)
            entry = rows[i + 1]["open"]
            outcome = barrier_outcome(
                rows[i + 1 : i + h + 1],
                entry,
                rows[i]["close"] - atr,
                rows[i]["close"] + 2 * atr,
                h,
            )
            if outcome is not None and all(
                b["time"] - a["time"] == 300
                for a, b in zip(rows[i - 199 : i], rows[i - 198 : i + 1])
            ):
                data.append({"i": i, "x": x[i], "y": outcome["label"], "outcome": outcome})
        record = {
            "hold_minutes": minutes,
            "sample_count": len(data),
            "validated": False,
            "status": "MODEL UNAVAILABLE — NO VALIDATED PREDICTION",
            "label": "ATR target-first / stop-first / timeout; next-open, 0.1% fees + 0.05% slippage each leg",
            "scope": "Generic ATR barrier benchmark; NOT calibrated probability for a custom profit target or rule setup",
        }
        if len(data) < 1500:
            record["reason"] = "Insufficient history"
            output.append(record)
            continue
        bounds = splits(len(data), h)
        sets = {k: data[a:b] for k, (a, b) in bounds.items()}
        if any(len(s) < 100 or len({r["y"] for r in s}) < 3 for s in sets.values()):
            record["reason"] = "Insufficient samples/classes after purge"
            output.append(record)
            continue
        X = {k: np.array([r["x"] for r in s]) for k, s in sets.items()}
        Y = {k: np.array([r["y"] for r in s]) for k, s in sets.items()}
        # Purge in actual time as well as row-index space.
        for left, right in zip(["train", "select", "calibrate"], ["select", "calibrate", "test"]):
            assert rows[sets[left][-1]["i"]]["time"] + h * 300 < rows[sets[right][0]["i"]]["time"]
        models = {
            "logistic": make_pipeline(StandardScaler(), LogisticRegression(max_iter=500)),
            "random_forest": RandomForestClassifier(
                n_estimators=80, max_depth=5, min_samples_leaf=30, random_state=17, n_jobs=1
            ),
            "lightgbm": LGBMClassifier(
                n_estimators=80,
                max_depth=4,
                num_leaves=12,
                min_child_samples=40,
                verbosity=-1,
                n_jobs=1,
                random_state=17,
            ),
        }
        registry = {}
        fitted = {}
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            for name, model in models.items():
                model.fit(X["train"], Y["train"])
                selection = model.predict_proba(X["select"])
                calibrated = CalibratedClassifierCV(FrozenEstimator(model), method="sigmoid")
                calibrated.fit(X["calibrate"], Y["calibrate"])
                probs = calibrated.predict_proba(X["test"])
                registry[name] = {
                    "selection_log_loss": float(log_loss(Y["select"], selection, labels=[0, 1, 2])),
                    **predict_metrics(Y["test"], probs),
                }
                fitted[name] = (calibrated, probs)
        winner = min(registry, key=lambda k: registry[k]["selection_log_loss"])
        if artifact_dir:
            folder = Path(artifact_dir) / version
            folder.mkdir(parents=True, exist_ok=True)
            joblib.dump(
                {
                    "model": fitted[winner][0],
                    "features": FEATURES,
                    "version": version,
                    "validated": False,
                    "product": product,
                    "horizon_minutes": minutes,
                },
                folder / f"{product}-{minutes}m.joblib",
            )
        prior = np.bincount(Y["train"], minlength=3) / len(Y["train"])
        baseline = np.tile(prior, (len(Y["test"]), 1))
        record.update(
            {
                "models": registry,
                "selected_without_test": winner,
                "class_prior_baseline": predict_metrics(Y["test"], baseline),
                "no_change_baseline": predict_metrics(
                    Y["test"], np.tile([0.001, 0.998, 0.001], (len(Y["test"]), 1))
                ),
                "splits": {
                    k: {
                        "count": len(s),
                        "start": rows[s[0]["i"]]["time"],
                        "end": rows[s[-1]["i"]]["time"],
                    }
                    for k, s in sets.items()
                },
                "purge_bars": h,
                "reason": "Exploratory benchmark only: limited regimes; no historical execution-book or custom-setup calibration",
            }
        )
        # Three strictly forward blocks with each model refitted on earlier bars only.
        folds = []
        for end in (int(len(data) * 0.55), int(len(data) * 0.7), int(len(data) * 0.85)):
            train = data[: end - h]
            test = data[end : min(end + int(len(data) * 0.1), len(data))]
            if len({r["y"] for r in train}) < 3:
                continue
            m = make_pipeline(StandardScaler(), LogisticRegression(max_iter=500)).fit(
                [r["x"] for r in train], [r["y"] for r in train]
            )
            folds.append(
                {
                    "train_end": rows[train[-1]["i"]]["time"],
                    "test_start": rows[test[0]["i"]]["time"],
                    "log_loss": float(
                        log_loss(
                            [r["y"] for r in test],
                            m.predict_proba([r["x"] for r in test]),
                            labels=[0, 1, 2],
                        )
                    ),
                }
            )
        record["walk_forward_logistic"] = folds
        # Regime performance from features at decision time, never future information.
        probs = fitted[winner][1]
        record["regimes"] = {}
        for regime, mask in [
            ("bull", X["test"][:, -1] > 0.001),
            ("bear", X["test"][:, -1] < -0.001),
            ("range", abs(X["test"][:, -1]) <= 0.001),
        ]:
            record["regimes"][regime] = {
                "count": int(mask.sum()),
                "metrics": predict_metrics(Y["test"][mask], probs[mask]) if mask.sum() else None,
            }
        means = np.array(
            [
                np.mean([v["outcome"]["net_return"] for v in sets["train"] if v["y"] == label])
                for label in range(3)
            ]
        )
        expected = probs @ means
        # Execute non-overlapping positive-estimated-EV test observations only.
        simulated = []
        available_after = 0
        for item, ev in zip(sets["test"], expected):
            decision_time = rows[item["i"]]["time"] + 300
            if ev > 0 and decision_time >= available_after:
                simulated.append(item["outcome"])
                available_after = item["outcome"]["exit_time"]
        record["expected_value_research"] = {
            "definition": "Sum of calibrated class probability times training-only mean NET outcome; costs already counted once",
            "training_net_means_stop_timeout_target": means.tolist(),
            "mean_estimated_net_return": float(expected.mean()),
            "held_out_positive_ev_policy": summarize_outcomes(simulated),
            "qualification": "Exploratory; standard error is descriptive, not a production confidence interval; no execution approval",
        }
        output.append(record)
    return {
        "product_id": product,
        "version": version,
        "status": "Fitted research benchmarks; NOT execution validated",
        "data_start": rows[0]["time"],
        "data_end": rows[-1]["time"],
        "features": FEATURES,
        "excluded_features": "No historical L2/spread/trade imbalance; no fabricated order flow",
        "horizons": output,
    }


def context_bars(rows, seconds):
    groups = {}
    for r in rows:
        groups.setdefault(r["time"] // seconds * seconds, []).append(r)
    out = []
    for start, rs in groups.items():
        if [r["time"] for r in rs] != list(range(start, start + seconds, 300)):
            continue
        out.append(
            {
                "time": start,
                "open": rs[0]["open"],
                "high": max(r["high"] for r in rs),
                "low": min(r["low"] for r in rs),
                "close": rs[-1]["close"],
                "volume": sum(r["volume"] for r in rs),
            }
        )
    return out


def setup_tests(rows):
    """Frozen rules on last 20% of history. One position per strategy/horizon.
    Rules are not selected using this holdout; no fitting of volume thresholds.
    """
    hourly = context_bars(rows, 3600)
    four = context_bars(rows, 14400)
    start = int(len(rows) * 0.8)
    outcomes = {}
    next_entry = {}
    names = ["Support rejection", "Breakout and retest", "Trend pullback", "Range trading"]
    for i in range(max(start, 200), len(rows) - 1):
        t = rows[i]["time"] + 300
        cs = candidates(
            rows[max(0, i - 249) : i + 1],
            [r for r in hourly if r["time"] + 3600 <= t][-200:],
            [r for r in four if r["time"] + 14400 <= t][-200:],
        )
        for c in cs:
            if c["state"] != "TRIGGERED":
                continue
            for minutes in (15, 60, 240, 1440):
                key = (c["setup"], minutes)
                if i < next_entry.get(key, 0):
                    continue
                outcome = barrier_outcome(
                    rows[i + 1 :], rows[i + 1]["open"], c["stop"], c["targets"][0], minutes // 5
                )
                if outcome:
                    outcomes.setdefault(key, []).append(outcome)
                    next_entry[key] = i + outcome["duration_bars"] + 1
    return [
        {
            "setup": name,
            "hold_minutes": minutes,
            **summarize_outcomes(outcomes.get((name, minutes), [])),
            "period_start": rows[start]["time"],
            "period_end": rows[-1]["time"] + 300,
            "validated": False,
            "execution": "Next-open taker simulation; full fill assumed, 0.1% fees + 0.05% slippage/leg; no historical liquidity proof",
            "reason": "Exploratory short-period holdout; require independent longer regimes and execution validation",
        }
        for name in names
        for minutes in (15, 60, 240, 1440)
    ]
