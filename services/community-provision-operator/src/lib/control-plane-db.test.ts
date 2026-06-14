import { describe, expect, test } from "bun:test";
import { assertRemoteControlPlaneUrl, ControlPlaneUrlError } from "./control-plane-db";

describe("assertRemoteControlPlaneUrl", () => {
  const remoteUrls = [
    "libsql://control.pirate-prod.aws-us-east-1.turso.io",
    "https://control.pirate-prod.example.com",
    "http://control.internal",
    "wss://control.pirate-prod.turso.io",
    "ws://control.internal",
    "postgres://user:pass@db.example.com:5432/control",
    "postgresql://user:pass@db.example.com:5432/control",
  ];

  for (const url of remoteUrls) {
    test(`accepts remote URL in production: ${url}`, () => {
      expect(() => assertRemoteControlPlaneUrl(url, { environment: "production" })).not.toThrow();
    });
  }

  test("accepts remote URL when environment is unset (treated as deployed)", () => {
    expect(() => assertRemoteControlPlaneUrl("libsql://control.turso.io")).not.toThrow();
  });

  test("rejects file: URL in production", () => {
    expect(() => assertRemoteControlPlaneUrl("file:./local.db", { environment: "production" }))
      .toThrow(ControlPlaneUrlError);
    try {
      assertRemoteControlPlaneUrl("file:/var/data/control.db", { environment: "production" });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ControlPlaneUrlError);
      expect((error as ControlPlaneUrlError).code).toBe("control_plane_url_invalid");
      const message = (error as Error).message;
      expect(message).toContain('"file:"');
      expect(message).toContain("production");
      // The full URL/path must never be echoed (it can carry credentials).
      expect(message).not.toContain("/var/data/control.db");
    }
  });

  test("rejects file: URL in staging", () => {
    expect(() => assertRemoteControlPlaneUrl("file:local.db", { environment: "staging" }))
      .toThrow(ControlPlaneUrlError);
  });

  test("allows file: URL in development and test", () => {
    expect(() => assertRemoteControlPlaneUrl("file:./dev.db", { environment: "development" })).not.toThrow();
    expect(() => assertRemoteControlPlaneUrl("file:./test.db", { environment: "test" })).not.toThrow();
    expect(() => assertRemoteControlPlaneUrl("", { environment: "test" })).not.toThrow();
  });

  test("is case- and whitespace-insensitive on the environment and scheme", () => {
    expect(() => assertRemoteControlPlaneUrl("file:./dev.db", { environment: "  Development " })).not.toThrow();
    expect(() => assertRemoteControlPlaneUrl("  LIBSQL://control.turso.io  ", { environment: "production" }))
      .not.toThrow();
    expect(() => assertRemoteControlPlaneUrl("FILE:./local.db", { environment: "production" }))
      .toThrow(ControlPlaneUrlError);
  });

  test("rejects an empty URL in production", () => {
    expect(() => assertRemoteControlPlaneUrl("   ", { environment: "production" }))
      .toThrow(/empty/);
  });

  test("rejects a bare path (no scheme) in production without echoing it", () => {
    try {
      assertRemoteControlPlaneUrl("/var/lib/control.db", { environment: "production" });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ControlPlaneUrlError);
      expect((error as Error).message).toContain("no URL scheme");
      expect((error as Error).message).not.toContain("/var/lib/control.db");
    }
  });

  test("rejects an unsupported scheme in production", () => {
    expect(() => assertRemoteControlPlaneUrl("mysql://db.example.com/control", { environment: "production" }))
      .toThrow(/unsupported scheme "mysql:"/);
  });
});
