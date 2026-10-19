import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = (path: string): string => readFileSync(join(import.meta.dir, "../../..", path), "utf-8");

const indexTs = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
const testerTs = readFileSync(join(import.meta.dir, "tester.ts"), "utf-8");
const adminTs = readFileSync(join(import.meta.dir, "admin.ts"), "utf-8");
const deployMd = root("docs/deploy.md");
const llmsTxt = root("llms.txt");
const readme = root("README.md");
const readmeZh = root("README.zh-CN.md");
const demoCompose = root("demo/docker-compose.yml");

const ENV_VARS = ["ADMIN_TOKEN", "PORT", "DB_PATH", "STATIC_DIR", "LOG_DIR"];

describe("docs match the code", () => {
  test("every env var the gateway reads is documented in docs/deploy.md", () => {
    for (const name of ENV_VARS) {
      expect(`${name} read by src: ${indexTs.includes(name) || testerTs.includes(name)}`).toBe(
        `${name} read by src: true`
      );
      expect(`${name} documented: ${deployMd.includes(name)}`).toBe(`${name} documented: true`);
    }
  });

  test("the default port in code is the one the docs tell you to open", () => {
    expect(indexTs).toContain("3001");
    expect(deployMd).toContain("3001");
    expect(llmsTxt).toContain("3101");
    expect(readme).toContain("3101");
  });

  test("the admin endpoints named in llms.txt exist in admin.ts", () => {
    for (const endpoint of ["/admin/providers", "/admin/routes", "/admin/keys"]) {
      expect(llmsTxt).toContain(endpoint);
      expect(adminTs).toContain(endpoint);
    }
  });

  test("the demo token and ports quoted in the docs are the demo stack's", () => {
    expect(demoCompose).toContain("demo-admin-token");
    expect(demoCompose).toContain("3101");
    expect(llmsTxt).toContain("demo-admin-token");
    expect(readmeZh).toContain("demo-admin-token");
    expect(llmsTxt).toContain("3101");
    expect(llmsTxt).toContain("sk-demo");
    expect(root("demo/seed.ts")).toContain("sk-demo");
  });

  test("the demo stack is described in exactly one place", () => {
    expect(llmsTxt).toContain("demo/docker-compose.yml");
    expect(readme).toContain("demo/docker-compose.yml");
    expect(deployMd).not.toContain("demo/docker-compose.yml up");
    expect(deployMd).toContain("llms.txt");
  });

  test("keys stay write-only in the docs", () => {
    expect(llmsTxt).toContain("write-only");
    expect(root("docs/gateway.md")).toContain("write-only");
  });
});
