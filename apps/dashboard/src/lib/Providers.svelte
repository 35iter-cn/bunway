<script>
  import { localHM, dayMark, dayList, localWindow, windowLabel, offsetLabel } from "./fmt.js";

  let { providers = [], routes = [], pricing = [], settings = [], computedAt = 0, token = "", onreload = () => {} } = $props();

  let pending = $state(null);
  let dragKey = $state(null);
  let dragModel = $state(null);
  let overKey = $state(null);
  let saveErr = $state(null);
  let dynErr = $state("");

  const PALETTE = ["var(--blue)", "var(--green)", "var(--amber)"];
  const STATE_TEXT = { ok: "OK", cool: "Cooling", dead: "Unavailable", off: "Disabled" };

  let now = $state(Date.now());

  const cfg = $derived(Object.fromEntries(settings.map((s) => [s.key, s.value])));
  const cooldownMin = $derived(cfg.cooldown_minutes_5xx ?? "5");
  const probeMin = $derived(cfg.test_interval_minutes ?? "60");

  const groups = $derived.by(() => {
    const by = new Map();
    for (const r of routes) {
      if (!by.has(r.gateway_model)) by.set(r.gateway_model, []);
      by.get(r.gateway_model).push(r);
    }
    return [...by.entries()]
      .map(([model, list]) => ({ model, cands: [...list].sort((a, b) => b.priority - a.priority) }))
      .sort((a, b) => a.model.localeCompare(b.model));
  });

  const usd = (n, digits = 2) => "$" + Number(n ?? 0).toFixed(digits);
  const tzOffset = -new Date().getTimezoneOffset();
  const dur = (ms) => {
    const m = Math.max(0, Math.round(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
  };
  const rk = (c) => `${c.provider_id}|${c.gateway_model}|${c.provider_model}`;
  const entryOf = (c) => pricing.find((e) => rk(e) === rk(c));
  const pricesOf = (c) => entryOf(c)?.now.prices ?? c.pricing?.default ?? {};
  const ruleOf = (c) => entryOf(c)?.now.rule ?? -1;
  const nextOf = (c) => entryOf(c)?.next_switch ?? null;
  const tierLabel = (rule) => (rule < 0 ? "Default" : `Rule ${"①②③④⑤"[rule] ?? rule + 1}`);
  const tiersOf = (c) => [
    { rule: -1, prices: c.pricing?.default ?? {} },
    ...(c.pricing?.rules ?? []).map((r, i) => ({ rule: i, prices: { ...c.pricing.default, ...r } })),
  ];
  const tierMark = (c, rule) => {
    if (rule === ruleOf(c)) return "current";
    const next = nextOf(c);
    return next && next.rule === rule ? `from ${dayMark(next.ts, now)} ${localHM(next.ts)}` : "";
  };
  const tierWindow = (c, rule) => {
    const w = c.pricing.rules[rule];
    return `${dayList(w.days, localWindow(w.windows[0]).dayShift)}${w.windows.map(windowLabel).join(" · ")}`;
  };
  const provOf = (id) => providers.find((p) => p.id === id);
  const stateOf = (p) => (!p ? "ok" : p.enabled === 0 ? "off" : p.unavailable ? "dead" : p.cooldown_until > now ? "cool" : "ok");
  const unitsOf = (p) => (Array.isArray(p?.units) ? p.units : []);
  const unitState = (u) => (u.unavailable ? "dead" : u.cooldown_until > now ? "cool" : "ok");
  const unitLeft = (u) => Math.max(0, Math.ceil((u.cooldown_until - now) / 1000));
  const color = (id) => PALETTE[Math.max(0, providers.findIndex((p) => p.id === id)) % PALETTE.length];
  const routesOf = (id) => routes.filter((r) => r.provider_id === id);
  const fwd = (p) => {
    try {
      return JSON.parse(p.meta || "{}").forward_headers ?? [];
    } catch {
      return [];
    }
  };
  const left = (p) => Math.max(0, Math.ceil((p.cooldown_until - now) / 1000));
  const effective = (cands) => cands.findIndex((c) => stateOf(provOf(c.provider_id)) === "ok");
  const dynamicOn = $derived(cfg.dynamic_priority === "1");
  const rankOf = (c) => entryOf(c)?.rank ?? c.priority;
  const selOrder = (g) => [...g.cands].sort((a, b) => rankOf(a) - rankOf(b));
  const activeId = (g) => {
    const sel = selOrder(g);
    const at = effective(sel);
    return at < 0 ? null : sel[at].provider_id;
  };

  async function toggleDynamic(e) {
    const on = e.currentTarget.checked;
    dynErr = "";
    try {
      const res = await fetch("/admin/settings", {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ dynamic_priority: on ? "1" : "0" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (ex) {
      dynErr = `dynamic order switch failed: ${ex.message}`;
    } finally {
      await onreload();
    }
  }

  const ordered = (g) =>
    pending?.model === g.model ? pending.order.map((k) => g.cands.find((c) => rk(c) === k)).filter(Boolean) : g.cands;

  function dragStart(g, c) {
    if (g.cands.length < 2) return;
    dragKey = rk(c);
    dragModel = g.model;
  }

  function dragOver(e, g, c) {
    if (dragModel !== g.model) return;
    e.preventDefault();
    overKey = rk(c);
  }

  function dragEnd() {
    dragKey = null;
    dragModel = null;
    overKey = null;
  }

  function drop(g, target) {
    const list = ordered(g);
    const from = list.findIndex((c) => rk(c) === dragKey);
    dragEnd();
    if (from < 0 || from === target) return;
    const order = list.map(rk);
    order.splice(target, 0, order.splice(from, 1)[0]);
    const moved = list[from];
    pending = {
      model: g.model,
      order,
      label: `${g.model}: ${moved.provider_name ?? moved.provider_id} #${from + 1} → #${target + 1}`,
    };
  }

  const cancel = () => (pending = null);

  async function commit(g) {
    const list = ordered(g);
    const n = list.length;
    saveErr = null;
    for (const [i, c] of list.entries()) {
      const priority = (n - i) * 5;
      if (priority === c.priority) continue;
      const q = new URLSearchParams({
        gateway_model: c.gateway_model,
        provider_id: String(c.provider_id),
        provider_model: c.provider_model,
      });
      try {
        const res = await fetch(`/admin/routes?${q}`, {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ priority }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        saveErr = { model: g.model, msg: `${c.provider_name ?? c.provider_id} priority write failed: ${e.message}` };
        break;
      }
    }
    try {
      await onreload();
    } finally {
      pending = null;
    }
  }

  const summary = $derived.by(() => {
    const c = { ok: 0, cool: 0, dead: 0, off: 0 };
    for (const p of providers) c[stateOf(p)]++;
    return c;
  });

  $effect(() => {
    if (!providers.some((p) => p.cooldown_until > now) && !pricing.some((e) => e.next_switch)) return;
    const iv = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(iv);
  });
</script>

<div class="dyn">
  <label>
    <input type="checkbox" checked={dynamicOn} onchange={toggleDynamic} />
    Dynamic price order
  </label>
  <span class="dyn-state">
    {#if dynamicOn}on · cheapest provider serves · computed {computedAt ? localHM(computedAt) : "-"}{:else}off · stored priority order{/if}
  </span>
  {#if dynErr}<span class="rt-err">{dynErr}</span>{/if}
</div>

{#each groups as g (g.model)}
  {@const act = activeId(g)}
  <div class="rt-row">
    <span class="gm">
      {g.model}
      <small>
        {g.cands.length} candidates{#if act === null}<span class="bad-cap"> · all unavailable → 502</span>{/if}
      </small>
    </span>
    <div class="chain" role="list">
      {#each ordered(g) as c, i (rk(c))}
        {@const p = provOf(c.provider_id)}
        {@const st = stateOf(p)}
        {@const price = pricesOf(c)}
        {@const rule = ruleOf(c)}
        {@const next = nextOf(c)}
        <span class={i === 0 ? "entry" : "conn"} class:live={act === c.provider_id}></span>
        <span
          class="node"
          role="listitem"
          class:eff={act === c.provider_id}
          class:st-cool={st === "cool"}
          class:st-dead={st === "dead"}
          class:st-off={st === "off"}
          class:drag={dragKey === rk(c)}
          class:over={overKey === rk(c)}
          style="--pc:{color(c.provider_id)}"
          draggable={g.cands.length > 1}
          ondragstart={() => dragStart(g, c)}
          ondragover={(e) => dragOver(e, g, c)}
          ondrop={(e) => {
            e.preventDefault();
            drop(g, i);
          }}
          ondragend={dragEnd}
        >
          <span class="node-card">
            <b>{c.provider_name ?? p?.name ?? c.provider_id}</b>
            <small class="price" class:rule={rule >= 0}>{usd(price.price_input)}/{usd(price.price_output)}</small>
            {#if st !== "ok"}<span class="st {st}">{STATE_TEXT[st]}{#if st === "cool"} · {left(p)}s left{/if}</span>{/if}
            {#if act === c.provider_id && next}<span class="countdown">→{localHM(next.ts)} {dur(next.ts - now)}</span>{/if}
          </span>
          <div class="pop">
            <div class="ph"><span class="nm">{p?.name ?? c.provider_id}</span><small style="color:var(--faint)">#{c.provider_id}</small><span class="st {st}">{STATE_TEXT[st]}{#if st === "cool"} · {left(p)}s left{/if}</span></div>
            <div class="pu">{p?.base_url ?? "?"}</div>
            {#if unitsOf(p).length > 1}
              <table><tbody>
                {#each unitsOf(p) as u (u.gateway_model)}
                  <tr>
                    <td>{u.gateway_model}</td>
                    <td>
                      {#if unitState(u) === "dead"}<span class="st dead">Unavailable</span>
                      {:else if unitState(u) === "cool"}<span class="st cool">Cooling · {unitLeft(u)}s left</span>
                      {:else}<span class="st ok">OK</span>{/if}
                    </td>
                  </tr>
                {/each}
              </tbody></table>
            {/if}
            <table><tbody>
              <tr><td>provider_model</td><td>{c.provider_model}</td></tr>
              <tr><td>priority / order</td><td>{c.priority} / #{i + 1}</td></tr>
              {#each tiersOf(c) as t (t.rule)}
                <tr class:cur={t.rule === ruleOf(c)}>
                  <td>{tierLabel(t.rule)}{#if tierMark(c, t.rule)}（{tierMark(c, t.rule)}）{/if}</td>
                  <td>in {usd(t.prices.price_input, 3)} · out {usd(t.prices.price_output, 3)}<br />
                    <span class="note">cache rd {usd(t.prices.price_cache_read, 3)} · cache wr {usd(t.prices.price_cache_write, 3)}</span></td>
                </tr>
                {#if t.rule >= 0}<tr class="w"><td colspan="2" class="win">{tierWindow(c, t.rule)}</td></tr>{/if}
              {/each}
              {#if fwd(p).length}<tr><td>forward headers</td><td class="fw">{fwd(p).join(" · ")}</td></tr>{/if}
              <tr><td>routes on provider</td><td>{routesOf(c.provider_id).length}</td></tr>
            </tbody></table>
            <div class="foot">unit price per 1M tokens · live status{#if tzOffset !== 0} · windows defined in UTC, shown in {offsetLabel()}{/if}</div>
          </div>
        </span>
      {/each}
      {#if g.cands.length === 1}
        <span class="conn"></span>
        <span class="empty-slot">no fallback</span>
      {/if}
      {#if act === null}<span class="bad-cap" style="margin-left:10px">→ all unavailable · 502</span>{/if}
    </div>
    {#if pending?.model === g.model}
      <div class="pending">
        <span>{pending.label}</span>
        <button class="on" onclick={() => commit(g)}>Confirm</button>
        <button onclick={cancel}>Cancel</button>
      </div>
    {/if}
    {#if saveErr?.model === g.model}<div class="rt-err">{saveErr.msg} (server values restored)</div>{/if}
  </div>
{/each}