import type { Database } from "bun:sqlite";
import type { Provider, Route } from "./db";
import { parsePricing } from "./billing";
import type { PricedRoute } from "./billing";
import { logError } from "./tester";

export type ErrClass = "unavailable" | "cooldown" | "nofailover" | "ok";

export type ProviderRuntime = {
  provider: Provider;
  routes: PricedRoute[];
  unavailable: boolean;
  cooldownUntil: number;
};

export function classifyError(status: number | null, err?: unknown): ErrClass {
  if (err) return "cooldown";
  if (status === null) return "cooldown";
  if (status >= 200 && status < 300) return "ok";
  if (status === 400 || status === 404 || status === 422) return "nofailover";
  if (status >= 500) return "cooldown";
  return "unavailable";
}

export class Router {
  private providers: ProviderRuntime[] = [];
  private db: Database;
  private cooldownSettings: () => number;

  constructor(db: Database, cooldownMinutes: () => number) {
    this.db = db;
    this.cooldownSettings = cooldownMinutes;
    this.reload();
  }

  reload(): void {
    const providers = this.db.query<Provider, []>("SELECT * FROM providers WHERE enabled=1").all();
    const routes = this.db
      .query<Route, []>("SELECT * FROM routes ORDER BY gateway_model, priority DESC")
      .all()
      .flatMap((r): PricedRoute[] => {
        const pricing = parsePricing(r.pricing);
        if (!pricing) {
          void logError({
            level: "error",
            event: "pricing_invalid",
            route: `${r.gateway_model}@${r.provider_id}/${r.provider_model}`,
          });
          return [];
        }
        return [{ ...r, pricing }];
      });
    this.providers = providers
      .map((p) => ({
        provider: { ...p, meta: p.meta || "{}" },
        routes: routes.filter((r) => r.provider_id === p.id),
        unavailable: false,
        cooldownUntil: 0,
      }))
      .filter((pr) => pr.routes.length > 0);
  }

  invalidate(): void {
    this.reload();
  }

  isAvailable(pr: ProviderRuntime, now: number): boolean {
    if (pr.unavailable) return false;
    if (pr.cooldownUntil > now) return false;
    return true;
  }

  pick(gatewayModel: string, now: number = Date.now()): ProviderRuntime[] {
    return this.providers
      .filter((pr) => pr.routes.some((r) => r.gateway_model === gatewayModel))
      .filter((pr) => this.isAvailable(pr, now))
      .sort((a, b) => {
        const pa = Math.max(...a.routes.filter((r) => r.gateway_model === gatewayModel).map((r) => r.priority));
        const pb = Math.max(...b.routes.filter((r) => r.gateway_model === gatewayModel).map((r) => r.priority));
        return pb - pa;
      });
  }

  routeFor(pr: ProviderRuntime, gatewayModel: string): PricedRoute {
    return pr.routes.filter((r) => r.gateway_model === gatewayModel).sort((a, b) => b.priority - a.priority)[0];
  }

  markResult(pr: ProviderRuntime, cls: ErrClass, now: number = Date.now()): void {
    if (cls === "ok") return;
    if (cls === "unavailable") {
      pr.unavailable = true;
      pr.cooldownUntil = 0;
    } else if (cls === "cooldown") {
      if (now >= pr.cooldownUntil) pr.cooldownUntil = now + this.cooldownSettings() * 60_000;
    }
  }

  markAvailable(pr: ProviderRuntime): void {
    pr.unavailable = false;
    pr.cooldownUntil = 0;
  }

  unavailableProviders(): ProviderRuntime[] {
    return this.providers.filter((p) => p.unavailable);
  }

  pricedRoutes(): PricedRoute[] {
    return this.providers.flatMap((pr) => pr.routes);
  }

  states(): Record<number, { unavailable: boolean; cooldown_until: number }> {
    const out: Record<number, { unavailable: boolean; cooldown_until: number }> = {};
    for (const pr of this.providers) {
      out[pr.provider.id] = { unavailable: pr.unavailable, cooldown_until: pr.cooldownUntil };
    }
    return out;
  }
}