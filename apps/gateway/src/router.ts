import type { Database } from "bun:sqlite";
import type { Provider, Route } from "./db";
import { parsePricing, priceIndex } from "./billing";
import type { PricedRoute } from "./billing";
import { logError } from "./tester";

export type ErrClass = "unavailable" | "cooldown" | "nofailover" | "ok";

const DYNAMIC_TICK_MS = 600_000;

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
  private orderTs = 0;
  private ranks = new Map<string, number[]>();
  private lastOrder = new Map<string, number[]>();
  private dynamic = false;

  constructor(db: Database, cooldownMinutes: () => number) {
    this.db = db;
    this.cooldownSettings = cooldownMinutes;
    this.reload();
  }

  reload(): void {
    this.orderTs = 0;
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

  private dynamicOn(): boolean {
    const row = this.db
      .query<{ value: string }, []>("SELECT value FROM settings WHERE key='dynamic_priority'")
      .get();
    return row?.value === "1";
  }

  private models(): string[] {
    return [...new Set(this.providers.flatMap((pr) => pr.routes.map((r) => r.gateway_model)))];
  }

  private candidatesFor(gatewayModel: string): ProviderRuntime[] {
    return this.providers.filter((pr) => pr.routes.some((r) => r.gateway_model === gatewayModel));
  }

  private maxPriority(pr: ProviderRuntime, gatewayModel: string): number {
    return Math.max(...pr.routes.filter((r) => r.gateway_model === gatewayModel).map((r) => r.priority));
  }

  private ensureOrder(now: number): void {
    if (this.orderTs === 0 || now - this.orderTs >= DYNAMIC_TICK_MS) this.recompute(now);
  }

  private recompute(now: number): void {
    this.ranks = new Map();
    this.orderTs = now;
    this.dynamic = this.dynamicOn();
    if (!this.dynamic) return;
    for (const model of this.models()) {
      const keyed = this.candidatesFor(model).map((pr) => {
        const r = this.routeFor(pr, model);
        return { id: pr.provider.id, idx: priceIndex(r, now), pri: r.priority };
      });
      keyed.sort((a, b) => a.idx - b.idx || b.pri - a.pri);
      const ids = keyed.map((k) => k.id);
      const from = this.lastOrder.get(model) ?? null;
      if (from !== null && from.join() !== ids.join()) {
        void logError({
          level: "info",
          event: "routing_order_changed",
          model,
          from,
          to: ids,
          index: keyed.map((k) => k.idx),
          computed_at: now,
        });
      }
      this.ranks.set(model, ids);
      this.lastOrder.set(model, ids);
    }
  }

  isAvailable(pr: ProviderRuntime, now: number): boolean {
    if (pr.unavailable) return false;
    if (pr.cooldownUntil > now) return false;
    return true;
  }

  pick(gatewayModel: string, now: number = Date.now()): ProviderRuntime[] {
    this.ensureOrder(now);
    const cands = this.candidatesFor(gatewayModel).filter((pr) => this.isAvailable(pr, now));
    const rank = this.ranks.get(gatewayModel);
    if (rank) return cands.sort((a, b) => rank.indexOf(a.provider.id) - rank.indexOf(b.provider.id));
    return cands.sort((a, b) => this.maxPriority(b, gatewayModel) - this.maxPriority(a, gatewayModel));
  }

  orderBasis(): { ts: number; dynamic: boolean; rankOf: (gatewayModel: string, providerId: number) => number } {
    this.ensureOrder(Date.now());
    const byPriority = new Map<string, number>();
    for (const model of this.models()) {
      this.candidatesFor(model)
        .map((pr) => ({ id: pr.provider.id, pri: this.maxPriority(pr, model) }))
        .sort((a, b) => b.pri - a.pri)
        .forEach((k, i) => byPriority.set(`${model}|${k.id}`, i + 1));
    }
    return {
      ts: this.orderTs,
      dynamic: this.dynamic,
      rankOf: (gatewayModel, providerId) => {
        const at = this.ranks.get(gatewayModel)?.indexOf(providerId) ?? -1;
        return at >= 0 ? at + 1 : (byPriority.get(`${gatewayModel}|${providerId}`) ?? 0);
      },
    };
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