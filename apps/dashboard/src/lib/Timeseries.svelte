<script>
  import { untrack } from "svelte";
  import uPlot from "uplot";
  import "uplot/dist/uPlot.min.css";

  let { series = [], daily = false, range = "7d" } = $props();
  let el;
  let plot;

  // x 轴刻度按数据分桶对齐:每 ~1/8 桶取一个 label,杜绝空刻度
  const bucketSec = () => (daily ? 86_400 : range === "today" ? 1_800 : 3_600);
  const xSplits = (u) => {
    const xs = u.data[0];
    if (xs.length < 2) return xs;
    const step = Math.ceil(xs.length / 8);
    const out = [];
    for (let i = 0; i < xs.length; i += step) out.push(xs[i]);
    return out;
  };
  const data = () => [
    series.map((s) => Math.floor(s.bucket / 1000)),
    series.map((s) => s.cost ?? 0),
    series.map((s) => s.requests ?? 0),
    series.map((s) => s.errors ?? 0),
  ];
  const showPoints = $derived(series.length <= 40);
  function xValues(u, splits) {
    return splits.map((v) => {
      const d = new Date(v * 1000);
      if (daily) return dayLabel(v);
      if (range === "today") return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return `${String(d.getHours()).padStart(2, "0")}:00`;
    });
  }

  const dayLabel = (v) => {
    const d = new Date(v * 1000);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const fullLabel = (v) => {
    const d = new Date(v * 1000);
    return daily ? dayLabel(v) : `${dayLabel(v)} ${String(d.getHours()).padStart(2, "0")}:00`;
  };

  $effect(() => {
    const d = data();
    if (plot && d[0].length) plot.setData(d);
  });

  $effect(() => {
    if (!el) return;
    void daily;
    void range;
    void showPoints;
    const initial = untrack(data);
    const opts = {
      width: el.clientWidth,
      height: 240,
      scales: { x: { time: true }, cost: { auto: true }, req: { auto: true } },
      axes: [
        {
          splits: xSplits,
          values: xValues,
          stroke: "#3d4550",
        },
        { scale: "cost", size: 64, stroke: "#6b7683", grid: { stroke: "#1c2128" }, values: (u, vs) => vs.map((v) => "$" + v.toFixed(2)) },
        { scale: "req", side: 1, size: 56, stroke: "#3d5a78", grid: { show: false } },
      ],
      series: [
        { value: (u, v) => (v == null ? "--" : fullLabel(v)) },
        { label: "成本$", stroke: "#f2a83b", scale: "cost", width: 1.5, points: { show: showPoints, size: 3 }, value: (u, v) => "$" + (v ?? 0).toFixed(4) },
        { label: "请求数", stroke: "#5b9bd5", scale: "req", width: 1.5, points: { show: showPoints, size: 3 } },
      ],
    };
    plot?.destroy();
    plot = new uPlot(opts, initial, el);
    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: 240 }));
    ro.observe(el);
    return () => { ro.disconnect(); plot?.destroy(); plot = null; };
  });
</script>

<div class="legend">
  <span><i style="background:var(--amber)"></i>成本 $</span>
  <span><i style="background:var(--blue)"></i>请求数</span>
</div>
<div bind:this={el}></div>
{#if !series.length}<div class="empty">范围内无数据</div>{/if}