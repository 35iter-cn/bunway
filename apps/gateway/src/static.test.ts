import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consoleRoutes, extname, resolveConsolePath } from "./static";

let dir: string;

beforeEach(() => {
  dir = join("/tmp", `gw-static-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>gw</title>");
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("extname", () => {
  test("dotfile has no extension", () => {
    expect(extname(".well-known")).toBe("");
    expect(extname("app.js")).toBe(".js");
  });
});

describe("resolveConsolePath", () => {
  test("root and extensionless paths → index.html", () => {
    expect(resolveConsolePath("/s", "/console")).toEqual({ file: "/s/index.html", isIndex: true });
    expect(resolveConsolePath("/s", "/console/")).toEqual({ file: "/s/index.html", isIndex: true });
    expect(resolveConsolePath("/s", "/console/some/route")).toEqual({ file: "/s/index.html", isIndex: true });
  });
  test("traversal rejected", () => {
    expect(resolveConsolePath("/s", "/console/../etc/passwd")).toBeNull();
    expect(resolveConsolePath("/s", "/console/assets/../../x")).toBeNull();
  });
  test("hashed asset resolved", () => {
    expect(resolveConsolePath("/s", "/console/assets/app-abc123.js")).toEqual({
      file: "/s/assets/app-abc123.js",
      isIndex: false,
    });
  });
});

describe("consoleRoutes", () => {
  const routes = () => consoleRoutes(dir);

  test("index served with no-cache", async () => {
    const res = await routes()("/console");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(await res.text()).toContain("<title>gw</title>");
  });

  test("asset served with immutable cache and mime", async () => {
    const res = await routes()("/console/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/javascript");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(await res.text()).toBe("console.log(1)");
  });

  test("missing asset with extension → 404", async () => {
    const res = await routes()("/console/assets/missing-xyz.js");
    expect(res.status).toBe(404);
  });

  test("traversal → 404", async () => {
    const res = await routes()("/console/../secret");
    expect(res.status).toBe(404);
  });
});