<script>
  import { Handle, Position } from "@xyflow/svelte";
  import { localHM } from "./fmt.js";

  let { data } = $props();

  const dur = (ms) => {
    const m = Math.max(0, Math.round(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
  };

  let now = $state(Date.now());
  $effect(() => {
    if (data.coolUntil <= now && (!data.nextTs || data.nextTs <= now)) return;
    const iv = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(iv);
  });

  const left = $derived(data.coolUntil > now ? Math.max(0, Math.ceil((data.coolUntil - now) / 1000)) : 0);
  const badge = $derived(
    data.st === "dead" ? "Unavailable" : data.st === "cool" ? `Cooling · ${left}s left` : data.st === "off" ? "Disabled" : ""
  );
</script>

<div class="node rf-node" class:st-cool={data.st === "cool"} class:st-dead={data.st === "dead"} class:st-off={data.st === "off"} style="--pc:{data.color}">
  {#if data.labelMode}
    <div class="mlabel">
      {data.name}
      {#if data.sub}<small class="msub" class:bad={data.allDead}>{data.sub}</small>{/if}
    </div>
    <Handle type="source" position={Position.Right} class="edge-dot" />
  {:else}
  <div class="node-card-wrap" class:eff={data.active}>
  <Handle type="target" position={Position.Left} class="edge-dot" />
  <span class="node-card" onclick={(e) => data.onpop?.(data, e)}>
    <b>{data.name}</b>
    <small class="price" class:rule={data.rule}>{data.price}</small>
    {#if badge}<span class="st {data.st}">{badge}</span>{/if}
    {#if data.active && data.nextTs > now}<span class="countdown">→{localHM(data.nextTs)} {dur(data.nextTs - now)}</span>{/if}
  </span>
  <Handle type="source" position={Position.Right} class="edge-dot" />
  </div>
  {/if}
</div>
