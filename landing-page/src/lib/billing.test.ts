import { describe, it, expect } from "vitest";
import { canBuyTopups, type PlanTier } from "./billing";

const TIERS: PlanTier[] = [
    { id: "free", name: "Free", priceUsd: 0, monthlyCredits: 150, order: 0 },
    { id: "pro", name: "Pro", priceUsd: 20, monthlyCredits: 2000, order: 1 },
    { id: "proplus", name: "Pro+", priceUsd: 50, monthlyCredits: 5000, order: 2 },
    { id: "ultra", name: "Ultra", priceUsd: 200, monthlyCredits: 20000, order: 3 },
];

describe("canBuyTopups", () => {
    it("is false on the free plan", () => {
        expect(canBuyTopups("free", TIERS)).toBe(false);
    });

    it("is true on every paid plan", () => {
        expect(canBuyTopups("pro", TIERS)).toBe(true);
        expect(canBuyTopups("proplus", TIERS)).toBe(true);
        expect(canBuyTopups("ultra", TIERS)).toBe(true);
    });

    it("fails closed on an unknown plan", () => {
        expect(canBuyTopups("enterprise", TIERS)).toBe(false);
        expect(canBuyTopups("", TIERS)).toBe(false);
    });

    it("fails closed when the tier ladder could not be loaded", () => {
        expect(canBuyTopups("pro", [])).toBe(false);
    });
});
