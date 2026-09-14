<script>
  let { items = [] } = $props();
</script>

<div class="kpis">
  {#each items as k (k.lbl)}
    <div class="kpi" style="--ac:{k.ac}">
      <div class="lbl">{k.lbl}</div>
      <div class="val">{k.val}</div>
      <div class="ksub">{@html k.sub}</div>
      {#if k.foot}<div class="kfoot">{k.foot}</div>{/if}
      {#if k.spark?.length}
        <svg class="spark" width="70" height="22" viewBox="0 0 70 22">
          <polyline
            points={k.spark.map((v, i) => `${((i / (k.spark.length - 1)) * 70).toFixed(1)},${(22 - (v / Math.max(...k.spark, 0.001)) * 19).toFixed(1)}`).join(' ')}
            fill="none" stroke={k.ac} stroke-width="1.5" opacity=".9"
          />
        </svg>
      {/if}
    </div>
  {/each}
</div>