import { expect, test } from "vitest";
import { number, stamp } from "../lib/utils";
test("never formats missing financial data as zero", () => {
  expect(number(null)).toBe("—");
  expect(number(undefined)).toBe("—");
  expect(number(NaN)).toBe("—");
});
test("UTC timestamps and numeric precision", () => {
  expect(stamp(1704067200)).toBe("00:00:00 UTC");
  expect(number(1.4057, 4)).toBe("1.4057");
});
