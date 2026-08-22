import { describe, it, expect } from "vitest";
import { canBuyTopups, usagePercent, type PlanTier } from "./billing";

const TIERS: PlanTier[] = [
    { id: "free", name: "Free", priceUsd: 0, monthlyCredits: 150, order: 0 },
    { id: "starter", name: "Starter", priceUsd: 5, monthlyCredits: 387, order: 1 },
    { id: "pro", name: "Pro", priceUsd: 25, monthlyCredits: 2097, order: 2 },
    { id: "max", name: "Max", priceUsd: 50, monthlyCredits: 4235, order: 3 },
];

describe("canBuyTopups", () => {
    it("is false on the free plan", () => {
        expect(canBuyTopups("free", TIERS)).toBe(false);
    });

    it("is true on every paid plan", () => {
        expect(canBuyTopups("starter", TIERS)).toBe(true);
        expect(canBuyTopups("pro", TIERS)).toBe(true);
        expect(canBuyTopups("max", TIERS)).toBe(true);
    });

    it("fails closed on an unknown plan", () => {
        expect(canBuyTopups("enterprise", TIERS)).toBe(false);
        expect(canBuyTopups("", TIERS)).toBe(false);
    });

    it("fails closed when the tier ladder could not be loaded", () => {
        expect(canBuyTopups("pro", [])).toBe(false);
    });
});

describe("usagePercent", () => {
    it("reports the used share, rounded to an integer", () => {
        expect(usagePercent(100, 50)).toBe(50);
        expect(usagePercent(387, 87)).toBe(78); // 300/387 = 77.5...% -> rounds to 78
        expect(usagePercent(100, 100)).toBe(0); // untouched grant -> 0% used
        expect(usagePercent(100, 0)).toBe(100); // fully spent -> 100% used
    });

    it("treats a zero grant as 100% used only when the balance is also zero", () => {
        expect(usagePercent(0, 0)).toBe(100);
        expect(usagePercent(0, 50)).toBe(0);
    });

    it("clamps a balance above the grant to 0% used", () => {
        // A race (e.g. a plan renewal landing before a debit is recorded) can
        // briefly leave balance > grant — must never report negative usage.
        expect(usagePercent(100, 150)).toBe(0);
    });

    it("clamps a negative balance (overdraft/topup debt) to 100% used", () => {
        expect(usagePercent(100, -20)).toBe(100);
    });

    it("clamps a negative grant the same way a zero grant does", () => {
        expect(usagePercent(-10, 0)).toBe(100);
        expect(usagePercent(-10, 5)).toBe(0);
    });
});
