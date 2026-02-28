import { describe, it, expect } from "vitest";
import { constant, linearRamp, sinePulse, easeInOut, bell, compose } from "./curves.js";

describe("curves", () => {
  describe("constant", () => {
    it("returns the same value for any t", () => {
      const f = constant(0.5);
      expect(f(0)).toBe(0.5);
      expect(f(0.5)).toBe(0.5);
      expect(f(1)).toBe(0.5);
    });
  });

  describe("linearRamp", () => {
    it("interpolates from a to b", () => {
      const f = linearRamp(0.2, 0.8);
      expect(f(0)).toBeCloseTo(0.2);
      expect(f(0.5)).toBeCloseTo(0.5);
      expect(f(1)).toBeCloseTo(0.8);
    });

    it("handles reversed range", () => {
      const f = linearRamp(1, 0);
      expect(f(0)).toBeCloseTo(1);
      expect(f(1)).toBeCloseTo(0);
    });
  });

  describe("sinePulse", () => {
    it("starts and ends at base", () => {
      const f = sinePulse(0.5, 0.3);
      expect(f(0)).toBeCloseTo(0.5);
      expect(f(1)).toBeCloseTo(0.5, 4);
    });

    it("peaks at midpoint", () => {
      const f = sinePulse(0.5, 0.3);
      expect(f(0.5)).toBeCloseTo(0.8);
    });
  });

  describe("easeInOut", () => {
    it("starts at a and ends at b", () => {
      const f = easeInOut(0.2, 0.9);
      expect(f(0)).toBeCloseTo(0.2);
      expect(f(1)).toBeCloseTo(0.9);
    });

    it("midpoint is midway", () => {
      const f = easeInOut(0, 1);
      expect(f(0.5)).toBeCloseTo(0.5);
    });

    it("is smooth (derivative is 0 at endpoints)", () => {
      const f = easeInOut(0, 1);
      const eps = 0.0001;
      const startSlope = (f(eps) - f(0)) / eps;
      const endSlope = (f(1) - f(1 - eps)) / eps;
      expect(Math.abs(startSlope)).toBeLessThan(0.01);
      expect(Math.abs(endSlope)).toBeLessThan(0.01);
    });
  });

  describe("bell", () => {
    it("peaks at center", () => {
      const f = bell(0.5, 0.2);
      expect(f(0.5)).toBeCloseTo(1);
    });

    it("falls off from center", () => {
      const f = bell(0.5, 0.2);
      expect(f(0)).toBeLessThan(0.1);
      expect(f(1)).toBeLessThan(0.1);
    });

    it("is symmetric", () => {
      const f = bell(0.5, 0.2);
      expect(f(0.3)).toBeCloseTo(f(0.7), 5);
    });
  });

  describe("compose", () => {
    it("applies outer(inner(t))", () => {
      const double = linearRamp(0, 2);
      const half = constant(0.5);
      const f = compose(double, half);
      expect(f(0)).toBeCloseTo(1); // double(0.5) = 1
      expect(f(1)).toBeCloseTo(1); // double(0.5) = 1
    });

    it("composes linearRamp with easeInOut", () => {
      const ramp = linearRamp(0, 1);
      const ease = easeInOut(0, 1);
      const f = compose(ramp, ease);
      // At t=0, ease(0)=0, ramp(0)=0
      expect(f(0)).toBeCloseTo(0);
      // At t=1, ease(1)=1, ramp(1)=1
      expect(f(1)).toBeCloseTo(1);
    });
  });
});
