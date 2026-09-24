<script>
  import { SvelteFlow, Background, BackgroundVariant, MarkerType } from "@xyflow/svelte";
  import "@xyflow/svelte/dist/style.css";
  import RouteNode from "./RouteNode.svelte";
  import { localHM, localWindow, windowLabel, offsetLabel, dayMark, dayList } from "./fmt.js";

  let { providers = [], routes = [], pricing = [], settings = [], computedAt = 0, token = "", onreload = () => {} } = $props();

  let saveErr = $state(null);
  let dynErr = $state("");
  let pop = $state(null);
  let wrapEl;
  const AMBER = "#f2a83b";

  const badgeOf = (st) => (st === "dead" ? "Unavailable" : st === "cool" ? "Cooling" : st === "off" ? "Disabled" : "OK");
  function showPop(d, e) {
    if (!wrapEl) return;
    if (pop?.d === d) return (pop = null);
    const r = e.currentTarget.getBoundingClientRect();
    const w = wrapEl.getBoundingClientRect();
    const x = r.left - w.left;
    pop = { d, x, y: r.bottom - w.top + 8, flip: x + 430 > w.width };
  }
  function wrapClick(e) {
    if (!e.target.closest(".node-card") && !e.target.closest(".flow-pop")) pop = null;
  }

  const PALETTE = ["var(--blue)", "var(--green)", "var(--amber)"];
  const COL_W = 320;
  const ROW_H = 120;

  let now = $state(Date.now());
  let flow;

  const cfg = $derived(Object.fromEntries(settings.map((s) => [s.key, s.value])));
  const dynamicOn = $derived(cfg.dynamic_priority === "1");

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
  const rk = (c) => `${c.provider_id}|${c.gateway_model}|${c.provider_model}`;
  const entryOf = (c) => pricing.find((e) => rk(e) === rk(c));
  const pricesOf = (c) => entryOf(c)?.now.prices ?? c.pricing?.default ?? {};
  const ruleOf = (c) => entryOf(c)?.now.rule ?? -1;
  const nextOf = (c) => entryOf(c)?.next_switch ?? null;
  const tierLabel = (rule) => (rule < 0 ? "Default" : `Rule ${"①②③④⑤"[rule] ?? rule + 1}`);
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
  const unitsOf = (p) => (Array.isArray(p?.units) ? p.units : []);
  const unitOf = (p, m) => unitsOf(p).find((u) => u.gateway_model === m);
  const unitStateOf = (p, m) => {
    if (!p) return "ok";
    if (p.enabled === 0) return "off";
    const u = unitOf(p, m);
    if (!u) return p.unavailable ? "dead" : p.cooldown_until > now ? "cool" : "ok";
    return u.unavailable ? "dead" : u.cooldown_until > now ? "cool" : "ok";
  };
  const color = (id) => PALETTE[Math.max(0, providers.findIndex((p) => p.id === id)) % PALETTE.length];
  const routesOf = (id) => routes.filter((r) => r.provider_id === id);
  const fwd = (p) => {
    try {
      return JSON.parse(p.meta || "{}").forward_headers ?? [];
    } catch {
      return [];
    }
  };
  const rankOf = (c) => entryOf(c)?.rank ?? c.priority;
  const selOrder = (g) => [...g.cands].sort((a, b) => b.priority - a.priority);
  const activeId = (g) => {
    const ok = selOrder(g).filter((c) => unitStateOf(provOf(c.provider_id), g.model) === "ok");
    if (!ok.length) return null;
    return [...ok].sort((a, b) => rankOf(a) - rankOf(b) || b.priority - a.priority)[0].provider_id;
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

  const nodeData = (c, i, active) => {
    const p = provOf(c.provider_id);
    const rule = ruleOf(c);
    return {
      name: c.provider_name ?? c.provider_id,
      pid: c.provider_id,
      baseUrl: p?.base_url ?? "?",
      providerModel: c.provider_model,
      prio: c.priority,
      i,
      price: `${usd(pricesOf(c).price_input)}/${usd(pricesOf(c).price_output)}`,
      rule: rule >= 0,
      st: unitStateOf(p, c.gateway_model),
      coolUntil: unitOf(p, c.gateway_model)?.cooldown_until ?? 0,
      active,
      nextTs: nextOf(c)?.ts ?? 0,
      color: color(c.provider_id),
      fwd: fwd(p),
      routesOn: routesOf(c.provider_id).length,
      tzNote: offsetLabel(),
      tiers: [
        { rule: -1, label: tierLabel(-1), mark: tierMark(c, -1), prices: c.pricing?.default ?? {}, cur: rule === -1, win: "" },
        ...(c.pricing?.rules ?? []).map((r, ri) => ({
          rule: ri,
          label: tierLabel(ri),
          mark: tierMark(c, ri),
          prices: { ...c.pricing.default, ...r },
          cur: rule === ri,
          win: tierWindow(c, ri),
        })),
      ].map((t) => ({
        rule: t.rule,
        label: t.label,
        mark: t.mark,
        cur: t.cur,
        win: t.win,
        pin: usd(t.prices.price_input, 3),
        pout: usd(t.prices.price_output, 3),
        pcr: usd(t.prices.price_cache_read, 3),
        pcw: usd(t.prices.price_cache_write, 3),
      })),
      onpop: showPop,
    };
  };

  const layout = $derived.by(() => {
    const rows = groups.map((g) => selOrder(g));
    return { rows, groups };
  });

  let nodes = $state.raw([]);
  let edges = $state.raw([]);
  let layoutKey = "";

  function build() {
    const ns = [];
    const es = [];
    layout.rows.forEach((row, r) => {
      const active = layout.groups[r].cands.length ? activeId(layout.groups[r]) : null;
      const allDead = row.every((c) => unitStateOf(provOf(c.provider_id), layout.groups[r].model) !== "ok");
      ns.push({
          id: `m:${layout.groups[r].model}`,
          type: "route",
          position: { x: -180, y: r * ROW_H },
          draggable: false,
          selectable: false,
          connectable: false,
          data: { labelMode: true, name: layout.groups[r].model, st: "ok", color: "var(--faint)", tiers: [], fwd: [], coolUntil: 0, nextTs: 0, price: "", sub: `${layout.groups[r].cands.length} candidate${layout.groups[r].cands.length === 1 ? "" : "s"}${allDead ? " · all unavailable → 502" : ""}`, allDead },
        });
      row.forEach((c, i) => {
        ns.push({
          id: rk(c),
          type: "route",
          position: { x: i * COL_W, y: r * ROW_H },
          draggable: row.length > 1,
          data: { ...nodeData(c, i, active === c.provider_id), row, allDead },
        });
      });
      const firstLive = active === row[0].provider_id;
      es.push({
        id: `m:${layout.groups[r].model}->${rk(row[0])}`,
        source: `m:${layout.groups[r].model}`,
        target: rk(row[0]),
        type: "straight",
        ...(firstLive ? { markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: AMBER } } : {}),
        animated: firstLive,
        class: firstLive ? "edge-live" : "edge-dim",
      });
      for (let i = 0; i < row.length - 1; i++) {
        const live = active === row[i + 1].provider_id;
        es.push({
          id: `${rk(row[i])}->${rk(row[i + 1])}`,
          source: rk(row[i]),
          target: rk(row[i + 1]),
          type: "straight",
          ...(live ? { markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: AMBER } } : {}),
          animated: live,
          class: live ? "edge-live" : "edge-dim",
        });
      }
    });
    nodes = ns;
    edges = es;
    requestAnimationFrame(() => {
      const el = (id) => document.querySelector(`.svelte-flow__node[data-id="${CSS.escape(id)}"]`);
      const xOf = new Map();
      layout.rows.forEach((row, r) => {
        let x = -180 + (el(`m:${layout.groups[r].model}`)?.offsetWidth ?? 140) + 48;
        for (const c of row) {
          xOf.set(rk(c), x);
          x += (el(rk(c))?.offsetWidth ?? COL_W) + 48;
        }
      });
      nodes = nodes.map((n) => (xOf.has(n.id) ? { ...n, position: { ...n.position, x: xOf.get(n.id) } } : n));
    });
  }

  $effect(() => {
    const key = JSON.stringify([layout.rows.map((r) => r.map(rk)), providers.map((p) => [p.id, p.enabled, p.unavailable, unitsOf(p).map((u) => [u.gateway_model, u.unavailable, u.cooldown_until])]), computedAt]);
    if (key === layoutKey) return;
    layoutKey = key;
    build();
  });

  function onDragStart(e) {
    saveErr = null;
    pop = null;
  }

  async function onDragStop(e) {
    const d = e?.detail ?? e;
    const node = d?.targetNode ?? d?.node;
    if (!node?.data?.row || node.data.row.length < 2) return;
    const xOf = new Map();
    for (const el of document.querySelectorAll(".svelte-flow__node")) xOf.set(el.dataset.id, el.getBoundingClientRect().left);
    const ordered = [...node.data.row].sort((a, b) => (xOf.get(rk(a)) ?? 0) - (xOf.get(rk(b)) ?? 0));
    if (ordered.every((c, i) => c === node.data.row[i])) return build();
    const n = ordered.length;
    saveErr = null;
    for (const [i, c] of ordered.entries()) {
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
      } catch (ex) {
        saveErr = { msg: `${c.provider_name ?? c.provider_id} priority write failed: ${ex.message}` };
        break;
      }
    }
    await onreload();
    build();
  }

  const unitSummary = $derived.by(() => {
    const c = { ok: 0, cool: 0, dead: 0, off: 0 };
    for (const g of groups) for (const cand of g.cands) c[unitStateOf(provOf(cand.provider_id), g.model)]++;
    return c;
  });

  $effect(() => {
    if (!providers.some((p) => p.cooldown_until > now) && !providers.some((p) => unitsOf(p).some((u) => u.cooldown_until > now)) && !pricing.some((e) => e.next_switch)) return;
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
  <span class="unit-sum">
    ok {unitSummary.ok} · cooling {unitSummary.cool} · unavailable {unitSummary.dead} · disabled {unitSummary.off}
  </span>
  {#if dynErr}<span class="rt-err">{dynErr}</span>{/if}
</div>

<div class="flow-wrap" bind:this={wrapEl} onclick={wrapClick}>
<div class="flow-canvas">
  <SvelteFlow bind:this={flow} {nodes} {edges} nodeTypes={{ route: RouteNode }} fitView fitViewOptions={{ padding: { left: 0.03, right: 0.12, top: 0.1, bottom: 0.1 } }} minZoom={0.4} maxZoom={1.6} panOnDrag nodesDraggable onnodedragstart={onDragStart} onnodedragstop={onDragStop} preventScrolling={false} proOptions={{ hideAttribution: true }}>
    <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
  </SvelteFlow>
  {#if saveErr}<div class="rt-err">{saveErr.msg} (server values restored)</div>{/if}
</div>
{#if pop}
  {@const d = pop.d}
  <div class="pop flow-pop" style="{pop.flip ? "right:8px" : `left:${pop.x}px`};top:{pop.y}px">
    <div class="ph"><span class="nm">{d.name}</span><small style="color:var(--faint)">#{d.pid}</small><span class="st {d.st}">{badgeOf(d.st)}</span></div>
    <div class="pu">{d.baseUrl}</div>
    <table><tbody>
      <tr><td>provider_model</td><td>{d.providerModel}</td></tr>
      <tr><td>priority / order</td><td>{d.prio} / #{d.i + 1}</td></tr>
      {#each d.tiers as t (t.rule)}
        <tr class:cur={t.cur}>
          <td>{t.label}{#if t.mark}（{t.mark}）{/if}</td>
          <td>in {t.pin} · out {t.pout}<br />
            <span class="note">cache rd {t.pcr} · cache wr {t.pcw}</span></td>
        </tr>
        {#if t.win}<tr class="w"><td colspan="2" class="win">{t.win}</td></tr>{/if}
      {/each}
      {#if d.fwd.length}<tr><td>forward headers</td><td class="fw">{d.fwd.join(" · ")}</td></tr>{/if}
      <tr><td>routes on provider</td><td>{d.routesOn}</td></tr>
    </tbody></table>
    <div class="foot">unit price per 1M tokens · live status{#if d.tzNote} · windows defined in UTC, shown in {d.tzNote}{/if}</div>
  </div>
{/if}
</div>
