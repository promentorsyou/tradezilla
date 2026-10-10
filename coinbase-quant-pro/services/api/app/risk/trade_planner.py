from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class RiskInput(BaseModel):
    entry: Decimal = Field(gt=0, le=1e9)
    exit: Decimal = Field(gt=0, le=1e9)
    stop: Decimal = Field(gt=0, le=1e9)
    amount: Decimal = Field(default=1000, gt=0, le=1e9)
    size_unit: Literal["quote", "base"] = "quote"
    fee_currency: Literal["quote", "base"] = "quote"
    entry_fee_pct: Decimal = Field(default=Decimal("0.4"), ge=0, le=5)
    exit_fee_pct: Decimal = Field(default=Decimal("0.6"), ge=0, le=5)
    slippage_pct: Decimal = Field(default=Decimal("0.05"), ge=0, le=5)
    spread_pct: Decimal = Field(default=Decimal("0.02"), ge=0, le=5)

    @model_validator(mode="after")
    def valid_stop(self):
        if self.stop >= self.entry:
            raise ValueError("Long-only stop must be below entry")
        return self


def calculate(p: RiskInput):
    f, g = p.entry_fee_pct / 100, p.exit_fee_pct / 100
    drag = (p.slippage_pct + p.spread_pct / 2) / 100
    entry = p.entry * (1 + drag)
    quantity = (
        p.amount / (entry * (1 + f if p.fee_currency == "quote" else 1))
        if p.size_unit == "quote"
        else p.amount
    )
    spent = quantity * entry
    if p.fee_currency == "base":
        acquired, basis = quantity * (1 - f), spent
    else:
        acquired, basis = quantity, spent * (1 + f)
    proceeds = acquired * p.exit * (1 - drag)
    net = proceeds * (1 - g) - basis
    stop_loss = basis - acquired * p.stop * (1 - drag) * (1 - g)
    return {
        "quantity_acquired": str(acquired),
        "quote_spent": str(spent),
        "entry_fee_quote_equivalent": str(spent * f),
        "total_cost_basis": str(basis),
        "exit_proceeds": str(proceeds),
        "exit_fees": str(proceeds * g),
        "net_profit": str(net),
        "loss_at_stop": str(stop_loss),
        "break_even": str(basis / (acquired * (1 - g) * (1 - drag))),
        "net_rr": str(net / stop_loss),
        "assumptions": "Quote amount is total budget including entry fee. Illustrative configurable fees, not your Coinbase tier. Full fill assumed. Post-only limits may not fill.",
    }
