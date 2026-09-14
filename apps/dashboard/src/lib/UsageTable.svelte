<script>
  import { fmtTok } from "./fmt.js";
  let { rows = [] } = $props();
  const COLS = [
    { key: "gateway_model", label: "Model", num: false },
    { key: "provider", label: "provider", num: false },
    { key: "provider_model", label: "Upstream Model", num: false },
    { key: "cost", label: "Cost", num: true },
    { key: "costShare", label: "Share", num: true },
    { key: "tokens", label: "tokens(in/out)", num: true },
    { key: "requests", label: "Reqs", num: true },
    { key: "ttft_p95_s", label: "TTFT p95", num: true },
  ];
  let sortKey = $state("cost");
  let sortDir = $state(-1);

  const enriched = $derived(
    (() => {
      const maxCost = Math.max(...rows.map((r) => r.cost ?? 0), 0.000001);
      return rows.map((r) => ({
      ...r,
      costShare: (r.cost ?? 0) / maxCost,
      ttft_p95_s: r.ttft_p95 > 0 ? r.ttft_p95 / 1000 : 0,
    }));
    })()
  );
  const sorted = $derived(
    [...enriched].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      return (typeof va === "number" ? va - vb : String(va).localeCompare(String(vb))) * sortDir;
    })
  );

  function sortBy(key) {
    if (sortKey === key) sortDir = -sortDir;
    else { sortKey = key; sortDir = -1; }
  }
  const money = (v) => "$" + (v ?? 0).toFixed(4);
  const secs = (v) => (v > 0 ? v.toFixed(1) + "s" : "—");
</script>

<table>
  <thead>
    <tr>
      {#each COLS as c (c.key)}
        <th class={sortKey === c.key ? (sortDir < 0 ? "desc" : "asc") : ""} onclick={() => sortBy(c.key)}>{c.label}</th>
      {/each}
    </tr>
  </thead>
  <tbody>
    {#each sorted as r (r.provider_id + r.gateway_model)}
      <tr>
        <td><span class="model">{r.gateway_model}</span></td>
        <td><span class="prov">{r.provider}</span></td>
        <td><span class="prov">{r.provider_model}</span></td>
        <td>{money(r.cost)}</td>
        <td><span class="bar" style="width:{Math.max(4, r.costShare * 140).toFixed(0)}px"></span></td>
        <td>{fmtTok(r.prompt_tokens)} / {fmtTok(r.completion_tokens)}</td>
        <td>{r.requests}</td>
        <td class="p95col">{secs(r.ttft_p95_s)}</td>
      </tr>
    {/each}
    {#if !sorted.length}<tr><td colspan="8" class="empty">No data in range</td></tr>{/if}
  </tbody>
</table>