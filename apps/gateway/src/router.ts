import type { Database } from "bun:sqlite";
import type { Provider } from "./db";
import { parsePricing, priceIndex } from "./billing";
import type { PricedRoute } from "./billing";
import { logError } from "./tester";

export type ErrClass = "unavailable" | "cooldown" | "nofailover" | "ok";

const DYNAMIC_TICK_MS = 600_000;

export type UnitRuntime = {
  provider: Provider;
  gatewayModel: string;
  route: PricedRoute;
  unavailable: boolean;
  cooldownUntil: number;
};

export type ProviderState = {
  unavailable: boolean;
  cooldown_until: number;
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
  private units: UnitRuntime[] = [];
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
    const prev = new Map(this.units.map((u) => [`${u.provider.id}|${u.gatewayModel}`, u] as const));
    this.orderTs = 0;
    const providers = this.db.query<Provider, []>("SELECT * FROM providers WHERE enabled=1").all();
    const routes = this.db
      .query<PricedRoute, []>("SELECT * FROM routes ORDER BY gateway_model, priority DESC")
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
    this.units = [];
    for (const p of providers) {
      const provider = { ...p, meta: p.meta || "{}" };
      for (const route of routes.filter((r) => r.provider_id === p.id)) {
        this.units.push({
          provider,
          gatewayModel: route.gateway_model,
          route,
          unavailable: prev.get(`${p.id}|${route.gateway_model}`)?.unavailable ?? false,
          cooldownUntil: prev.get(`${p.id}|${route.gateway_model}`)?.cooldownUntil ?? 0,
        });
      }
    }
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
    return [...new Set(this.units.map((u) => u.gatewayModel))];
  }

  private maxPriority(gatewayModel: string, providerId: number): number {
    return Math.max(
      ...this.units
        .filter((u) => u.gatewayModel === gatewayModel && u.provider.id === providerId)
        .map((u) => u.route.priority)
    );
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
      const providerIds = [...new Set(this.units.filter((u) => u.gatewayModel === model).map((u) => u.provider.id))];
      const keyed = providerIds.map((id) => {
        const u = this.units.find((x) => x.gatewayModel === model && x.provider.id === id)!;
        return { id, idx: priceIndex(u.route, now), pri: u.route.priority };
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

  isAvailable(u: UnitRuntime, now: number): boolean {
    if (u.unavailable) return false;
    if (u.cooldownUntil > now) return false;
    return true;
  }

  pick(gatewayModel: string, now: number = Date.now()): UnitRuntime[] {
    this.ensureOrder(now);
    const cands = this.units.filter((u) => u.gatewayModel === gatewayModel && this.isAvailable(u, now));
    const rank = this.ranks.get(gatewayModel);
    if (rank) return cands.sort((a, b) => rank.indexOf(a.provider.id) - rank.indexOf(b.provider.id));
    return cands.sort((a, b) => b.route.priority - a.route.priority);
  }

  orderBasis(): { ts: number; dynamic: boolean; rankOf: (gatewayModel: string, providerId: number) => number } {
    this.ensureOrder(Date.now());
    const byPriority = new Map<string, number>();
    for (const model of this.models()) {
      const providerIds = [...new Set(this.units.filter((u) => u.gatewayModel === model).map((u) => u.provider.id))];
      providerIds
        .map((id) => ({ id, pri: this.maxPriority(model, id) }))
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

  markResult(gatewayModel: string, providerId: number, cls: ErrClass, now: number = Date.now()): void {
    const u = this.units.find((x) => x.gatewayModel === gatewayModel && x.provider.id === providerId);
    if (!u) return;
    if (cls === "ok") return;
    if (cls === "unavailable") {
      u.unavailable = true;
      u.cooldownUntil = 0;
    } else if (cls === "cooldown") {
      if (now >= u.cooldownUntil) u.cooldownUntil = now + this.cooldownSettings() * 60_000;
    }
  }

  markAvailable(providerId: number, gatewayModel: string): void {
    const u = this.units.find((x) => x.gatewayModel === gatewayModel && x.provider.id === providerId);
    if (!u) return;
    u.unavailable = false;
    u.cooldownUntil = 0;
  }

  unavailableUnits(): UnitRuntime[] {
    return this.units.filter((u) => u.unavailable);
  }

  pricedRoutes(): PricedRoute[] {
    return this.units.map((u) => u.route);
  }

  unitsState(): Array<{ provider_id: number; gateway_model: string; unavailable: boolean; cooldown_until: number }> {
    return this.units.map((u) => ({
      provider_id: u.provider.id,
      gateway_model: u.gatewayModel,
      unavailable: u.unavailable,
      cooldown_until: u.cooldownUntil,
    }));
  }

  states(): Record<number, ProviderState> {
    const byProvider = new Map<number, UnitRuntime[]>();
    for (const u of this.units) {
      const list = byProvider.get(u.provider.id) ?? [];
      list.push(u);
      byProvider.set(u.provider.id, list);
    }
    const out: Record<number, ProviderState> = {};
    for (const [id, units] of byProvider) {
      out[id] = {
        unavailable: units.every((u) => u.unavailable),
        cooldown_until: Math.max(...units.map((u) => u.cooldownUntil)),
      };
    }
    return out;
  }
}