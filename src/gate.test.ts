import { describe, expect, test } from "bun:test";
import { isAllowedOwner, parseAllowedOwners } from "./gate.ts";

describe("parseAllowedOwners", () => {
  test("splits, trims, lower-cases and drops empties", () => {
    expect(parseAllowedOwners("Taka499, tia-tools ,,")).toEqual(["taka499", "tia-tools"]);
    expect(parseAllowedOwners("solo")).toEqual(["solo"]);
  });

  test("an unset or blank variable allows nobody", () => {
    expect(parseAllowedOwners(undefined)).toEqual([]);
    expect(parseAllowedOwners("")).toEqual([]);
    expect(parseAllowedOwners(" , ")).toEqual([]);
  });
});

describe("isAllowedOwner", () => {
  const allowed = parseAllowedOwners("Taka499,tia-tools");

  test("matches owners regardless of case", () => {
    expect(isAllowedOwner("Taka499", allowed)).toBe(true);
    expect(isAllowedOwner("TAKA499", allowed)).toBe(true);
    expect(isAllowedOwner("tia-tools", allowed)).toBe(true);
  });

  test("refuses other owners, prefixes and empty names", () => {
    expect(isAllowedOwner("Taka4999", allowed)).toBe(false);
    expect(isAllowedOwner("Taka49", allowed)).toBe(false);
    expect(isAllowedOwner("tia", allowed)).toBe(false);
    expect(isAllowedOwner("", allowed)).toBe(false);
    expect(isAllowedOwner("Taka499", [])).toBe(false);
  });
});
