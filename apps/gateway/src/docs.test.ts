import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = (path: string): string => readFileSync(join(import.meta.dir, "../../..", path), "utf-8");
const repoPath = (path: string): string => join(import.meta.dir, "../../..", path);

const indexTs = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
const testerTs = readFileSync(join(import.meta.dir, "tester.ts"), "utf-8");
const adminTs = readFileSync(join(import.meta.dir, "admin.ts"), "utf-8");
const deployMd = root("docs/deploy.md");
const gatewayMd = root("docs/gateway.md");
const llmsTxt = root("llms.txt");
const readme = root("README.md");
const deployCompose = root("deploy/docker-compose.service.yml");

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
    expect(llmsTxt).toContain("3001");
    expect(readme).toContain("3001");
  });

  test("the admin endpoints named in llms.txt exist in admin.ts", () => {
    for (const endpoint of ["/admin/providers", "/admin/routes", "/admin/keys"]) {
      expect(llmsTxt).toContain(endpoint);
      expect(adminTs).toContain(endpoint);
    }
  });

  test("the demo provider is a compose profile, not a second environment", () => {
    expect(deployCompose).toContain("mock-upstream");
    expect(deployCompose).toContain('profiles: ["demo"]');
    expect(llmsTxt).toContain("--profile demo");
    expect(llmsTxt).toContain("mock-upstream:3102");
    expect(existsSync(repoPath("demo/docker-compose.yml"))).toBe(false);
    expect(existsSync(repoPath("demo/seed.ts"))).toBe(false);
  });

  test("keys stay write-only in the docs", () => {
    expect(llmsTxt).toContain("write-only");
    expect(gatewayMd).toContain("write-only");
  });
});
