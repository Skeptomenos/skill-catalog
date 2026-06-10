import { describe, expect, it } from "vitest";
import { isAuthorizedBearerHeader } from "../src/security/auth.js";

describe("bearer authorization", () => {
  it("allows intentional no-auth mode when no configured token exists", () => {
    expect(isAuthorizedBearerHeader(undefined, undefined)).toBe(true);
    expect(isAuthorizedBearerHeader("Basic anything", undefined)).toBe(true);
  });

  it("accepts only well-formed bearer tokens that match the configured token", () => {
    expect(isAuthorizedBearerHeader("Bearer admin-secret", "admin-secret")).toBe(true);
    expect(isAuthorizedBearerHeader(undefined, "admin-secret")).toBe(false);
    expect(isAuthorizedBearerHeader("Basic admin-secret", "admin-secret")).toBe(false);
    expect(isAuthorizedBearerHeader("Bearer wrong-secret", "admin-secret")).toBe(false);
    expect(isAuthorizedBearerHeader("Bearer admin-secret extra", "admin-secret")).toBe(false);
    expect(isAuthorizedBearerHeader("Bearer ", "admin-secret")).toBe(false);
  });
});
