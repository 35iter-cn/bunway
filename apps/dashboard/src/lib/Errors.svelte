<script>
  let { data = { counts: {}, recent: [] } } = $props();
  let openTs = $state(null);
  let filter = $state("all");

  const color = (e) =>
    e === "no_available_provider" || e === "upstream_failed" ? "var(--red)"
    : e === "upstream_error" || e === "upstream_rejected" ? "var(--red)"
    : e === "client_aborted" ? "var(--amber)"
    : "var(--faint)";
  const level = (e) =>
    e === "no_available_provider" ? "fatal" : e === "client_aborted" ? "warn" : e === "usage_missing" ? "" : "err";
  const ago = (ts) => {
    const ms = Date.now() - new Date(ts).getTime();
    if (!Number.isFinite(ms)) return "";
    if (ms < 60000) return `-${Math.max(0, Math.round(ms / 1000))}s`;
    if (ms < 3600000) return `-${Math.round(ms / 60000)}m`;
    return `-${Math.round(ms / 3600000)}h`;
  };
  const sorted = $derived(Object.entries(data.counts).sort((a, b) => b[1] - a[1]));
  const total = $derived(sorted.reduce((a, [, c]) => a + c, 0));
  const max = $derived(sorted.length ? Math.max(...sorted.map(([, c]) => c)) : 0);
  const shown = $derived(filter === "all" ? data.recent : data.recent.filter((e) => e.event === filter));

  function pick(e) {
    filter = filter === e ? "all" : e;
    openTs = null;
  }
</script>

<div class="errs">
  <div class="ecount">
    <div class="erow" class:sel={filter === "all"} style="--evc:var(--faint)" onclick={() => pick("all")}>
      <i></i><span>All</span><b>{total}</b>
    </div>
    {#each sorted as [e, c] (e)}
      <div class="erow" class:sel={filter === e} style="--evc:{color(e)}" onclick={() => pick(e)}>
        <i></i><span>{e}</span><i class="bar" style="width:{Math.max(3, (c / (max || 1)) * 54).toFixed(0)}px"></i><b>{c}</b>
      </div>
    {:else}
      <div class="erow" style="--evc:var(--faint)"><i></i><span>No events</span></div>
    {/each}
  </div>
  <div class="stream">
    {#each shown as ev, i (ev.ts + ev.event + i)}
      <div
        class="ev"
        style="--evc:{color(ev.event)}"
        onclick={() => (openTs = openTs === ev.ts + ev.event ? null : ev.ts + ev.event)}
      >
        <span class="t">{ago(ev.ts)}</span>
        <span class="e">{ev.event}</span>
        <span class="p">{[ev.provider, ev.model].filter(Boolean).join(" · ") || "—"}</span>
        {#if openTs === ev.ts + ev.event}
          <div class="det">{JSON.stringify(ev, null, 2)}</div>
        {/if}
      </div>
    {:else}
      <div class="empty">No events</div>
    {/each}
  </div>
</div>