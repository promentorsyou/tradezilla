import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export const number = (n: number | string | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(Number(n))
    ? "—"
    : Number(n).toLocaleString("en-US", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });
export const stamp = (s?: string | number) =>
  s
    ? new Date(typeof s === "number" ? s * 1000 : s)
        .toISOString()
        .slice(11, 19) + " UTC"
    : "Not available";
