import { describe, expect, it } from "vitest";
import { healthBodyOk } from "@/lib/backend";

describe("healthBodyOk", () => {
  it("accepts the backend's health JSON", () => {
    expect(healthBodyOk({ ok: true })).toBe(true);
  });
  it("rejects HTML splash pages, wrong shapes, and null", () => {
    expect(healthBodyOk(null)).toBe(false); // res.json() failed → HTML body
    expect(healthBodyOk({})).toBe(false);
    expect(healthBodyOk({ ok: "true" })).toBe(false);
    expect(healthBodyOk("<html>suspended</html>")).toBe(false);
  });
});
