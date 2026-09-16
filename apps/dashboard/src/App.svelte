<script>
  import Kpi from "./lib/Kpi.svelte";
  import Providers from "./lib/Providers.svelte";
  import Timeseries from "./lib/Timeseries.svelte";
  import UsageTable from "./lib/UsageTable.svelte";
  import Errors from "./lib/Errors.svelte";
  import { fmtTok } from "./lib/fmt.js";

  const RANGES = ["today", "7d", "30d"];
  const RANGE_LABEL = { today: "Today", "7d": "7D", "30d": "30D" };
  const RANGE_DAYS = { today: 1, "7d": 7, "30d": 30 };

  let token = $state(localStorage.getItem("llmgw_token") ?? "");
  let tokenInput = $state(token);
  let range = $state("today");
  let stats = $state([]);
  let series = $state([]);
  let errors = $state({ counts: {}, recent: [] });
  let providers = $state([]);
  let routes = $state([]);
  let pricing = $state([]);
  let pricingComputedAt = $state(0);
  let ttft = $state({ global: null, by_provider: [] });
  let settings = $state([]);
  let err = $state("");
  let loading = $state(false);
  let spin = $state(false);
  let lastLoad = $state(0);

  function windowParams(r) {
    const now = Date.now();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const daysBack = r === "today" ? 0 : r === "7d" ? 6 : 29;
    const since = daysBack === 0 ? midnight.getTime() : midnight.getTime() - daysBack * 86_400_000;
    return `since=${since}&until=${now}&tz=${-new Date().getTimezoneOffset()}`;
  }

  async function load() {
    if (!token) return;
    err = "";
    try {
      const H = { Authorization: "Bearer " + token };
      const wp = windowParams(range);
      const [s, t, e, pv, rt, st, pr, tf] = await Promise.all([
        fetch("/admin/stats?" + wp, { headers: H }),
        fetch("/admin/stats/timeseries?" + wp, { headers: H }),
        fetch("/admin/errors?" + wp + "&limit=50", { headers: H }),
        fetch("/admin/providers", { headers: H }),
        fetch("/admin/routes", { headers: H }),
        fetch("/admin/settings", { headers: H }),
        fetch("/admin/pricing", { headers: H }),
        fetch("/admin/ttft?" + wp, { headers: H }),
      ]);
      if (s.status === 401 || t.status === 401 || e.status === 401 || pv.status === 401 || pr.status === 401 || tf.status === 401) throw new Error("invalid admin token");
      if (!s.ok || !t.ok || !e.ok || !pv.ok || !rt.ok || !st.ok || !pr.ok || !tf.ok) throw new Error(`HTTP ${s.status}/${t.status}/${e.status}`);
      stats = (await s.json()).data;
      series = (await t.json()).data;
      errors = (await e.json()).data;
      providers = (await pv.json()).data;
      routes = (await rt.json()).data;
      const prBody = await pr.json();
      pricing = prBody.data;
      pricingComputedAt = prBody.computed_at ?? 0;
      ttft = (await tf.json()).data;
      settings = (await st.json()).data;
      lastLoad = Date.now();
      localStorage.setItem("llmgw_token", token);
      tokenInput = token;
    } catch (ex) {
      err = String(ex.message ?? ex);
      if (err.includes("invalid admin token")) localStorage.removeItem("llmgw_token");
    }
  }

  function commitToken() {
    token = tokenInput.trim();
    if (token) load();
  }

  function setRange(r) {
    range = r;
  }

  async function refresh() {
    spin = true;
    await load();
    setTimeout(() => (spin = false), 500);
  }

  $effect(() => {
    if (!token) return;
    load();
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  });

  const provSummary = $derived.by(() => {
    const c = { ok: 0, cool: 0, dead: 0, off: 0 };
    for (const p of providers) {
      const st = p.enabled === 0 ? "off" : p.unavailable ? "dead" : p.cooldown_until > Date.now() ? "cool" : "ok";
      c[st]++;
    }
    return c;
  });

  const cfg = $derived(Object.fromEntries(settings.map((s) => [s.key, s.value])));
  const cooldownMin = $derived(cfg.cooldown_minutes_5xx ?? "5");
  const probeMin = $derived(cfg.test_interval_minutes ?? "60");

  const kpis = $derived.by(() => {
    if (!stats.length) return [];
    const sum = (k) => stats.reduce((a, r) => a + (r[k] ?? 0), 0);
    const max = (k) => Math.max(...series.map((s) => s[k] ?? 0), 0);
    const p95 = ttft.global ? (ttft.global.p95 / 1000).toFixed(1) + "s" : "—";
    const avg = ttft.global ? `avg <b>${(ttft.global.avg / 1000).toFixed(1)}s</b>` : "—";
    const totalReq = sum("requests");
    const tin = sum("prompt_tokens"), tout = sum("completion_tokens"), tcache = sum("cache_read_tokens");
    return [
      { lbl: "Total Cost", val: "$" + sum("cost").toFixed(2), sub: `peak <b>$${max("cost").toFixed(2)}</b> / bucket`, ac: "var(--amber)", spark: series.map((s) => s.cost ?? 0) },
      { lbl: "Requests", val: totalReq, sub: `avg/day <b>${Math.round(totalReq / RANGE_DAYS[range])}</b>`, ac: "var(--blue)", spark: series.map((s) => s.requests ?? 0) },
      { lbl: "Tokens", val: fmtTok(tin + tout), sub: `in <b>${fmtTok(tin)}</b> / out <b>${fmtTok(tout)}</b> / cache <b>${fmtTok(tcache)}</b>`, ac: "var(--blue)", spark: series.map((s) => s.tokens ?? 0) },
      { lbl: "TTFT p95", val: p95, sub: avg, ac: "var(--green)", spark: series.map((s) => s.ttft_avg ?? 0),
        foot: ttft.by_provider.map((p) => `${p.name} ${(p.p95 / 1000).toFixed(1)}s`).join(" · ") },
    ];
  });
</script>

<div class="wrap">
  <header>
    <div class="logo">bunway<em>://</em>console</div>
    <div class="token">
      token
      <input
        type="password"
        bind:value={tokenInput}
        onkeydown={(e) => e.key === "Enter" && commitToken()}
        placeholder="admin token"
      />
    </div>
    <div class="spacer"></div>
    <div class="range">
      {#each RANGES as r (r)}
        <button class:on={range === r} onclick={() => setRange(r)}>{RANGE_LABEL[r]}</button>
      {/each}
    </div>
    <button class="btn {spin ? 'spin' : ''}" onclick={refresh}><i>⟳</i> Refresh</button>
  </header>

  {#if err}<div class="err-banner">{err}</div>{/if}

  {#if token}
    {#if kpis.length}<Kpi items={kpis} />{/if}

    <section class="panel full">
      <h2><span class="dot"></span>Cost / Request Trend</h2>
      <div class="bd"><Timeseries {series} daily={range !== 'today'} {range} /></div>
    </section>

    {#if providers.length}
      <section class="panel full">
        <h2>
          <span class="dot"></span>Route Topology
          <span class="cap">{providers.length} providers (ok {provSummary.ok} · cooling {provSummary.cool} · unavailable {provSummary.dead} · disabled {provSummary.off}) · {routes.length} routes · 5xx cooldown {cooldownMin}min/probe {probeMin}min</span>
        </h2>
        <div class="bd"><Providers {providers} {routes} {pricing} {settings} computedAt={pricingComputedAt} {token} onreload={load} /></div>
      </section>
    {/if}

    <section class="panel full">
      <h2><span class="dot"></span>Model × Provider Usage</h2>
      <div class="bd" style="padding:0"><UsageTable rows={stats} /></div>
    </section>

    <section class="panel full">
      <h2><span class="dot"></span>Events
        <span class="cap">{Object.keys(errors.counts).length} event types · {errors.recent.length} recent (JSONL kept 7 days) · click a type to filter</span>
      </h2>
      <div class="bd"><Errors data={errors} /></div>
    </section>

  {:else if !token}    <div class="err-banner">Enter admin token to load (Bearer header, same token as the /admin API)</div>
  {/if}

  <footer>
    <span>bunway · bun · sqlite</span>
    <span>{lastLoad ? `Last refresh ${new Date(lastLoad).toLocaleTimeString()} · poll 10s · range=${range}` : `poll 10s · range=${range}`}</span>
  </footer>
</div>