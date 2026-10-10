"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Frame } from "./api";
type State = {
  product: string;
  frame: Frame;
  watchlist: string[];
  fee: number;
  slippage: number;
  overlays: string[];
  setProduct: (p: string) => void;
  setFrame: (f: Frame) => void;
  toggle: (v: string) => void;
  setFee: (v: number) => void;
  setSlippage: (v: number) => void;
  add: (p: string) => void;
  remove: (p: string) => void;
};
export const useSettings = create<State>()(
  persist(
    (set) => ({
      product: "XRP-USDC",
      frame: "1H",
      watchlist: [
        "XRP-USDC",
        "BTC-USDC",
        "ETH-USDC",
        "SOL-USDC",
        "ADA-USDC",
        "ZEC-USDC",
      ],
      fee: 0.6,
      slippage: 0.05,
      overlays: ["ema20", "ema50", "zones"],
      setProduct: (product) => set({ product }),
      setFrame: (frame) => set({ frame }),
      toggle: (v) =>
        set((s) => ({
          overlays: s.overlays.includes(v)
            ? s.overlays.filter((x) => x !== v)
            : [...s.overlays, v],
        })),
      setFee: (fee) => set({ fee }),
      setSlippage: (slippage) => set({ slippage }),
      add: (p) =>
        set((s) => ({
          watchlist: [...new Set([...s.watchlist, p])].slice(0, 20),
          product: p,
        })),
      remove: (p) =>
        set((s) => ({ watchlist: s.watchlist.filter((x) => x !== p) })),
    }),
    { name: "quant-pro-settings-v1" },
  ),
);
