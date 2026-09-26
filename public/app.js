// Tender dashboard. Vanilla JS: streams a run over SSE and renders the
// timeline, budget meter, answer, receipt and evidence.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const usd = (s) => parseFloat(String(s ?? "").replace("$", "")) || 0;
  const money = (n) => "$" + (n >= 1 ? n.toFixed(2) : n.toFixed(3));
  const short = (h) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "");
  const EXPLORER = { "eip155:84532": "https://sepolia.basescan.org", "eip155:8453": "https://basescan.org" };
  const NETWORK_NAME = { "eip155:84532": "Base Sepolia", "eip155:8453": "Base mainnet" };

  const ICON = {
    task: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    think: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
    block: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
    pay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.7 0-3 1-3 2.2 0 3 6 1.6 6 4.6 0 1.2-1.3 2.2-3 2.2-1 0-2-.5-2.5-1.5M12 6.5v1.5M12 16v1.5"/></svg>',
    answer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>',
    copy: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  };

  const EXAMPLES = [
    ["price", "What's ETH trading at right now?"],
    ["trend", "Has SOL been in an uptrend over the past month, and how volatile was it?"],
    ["decision", "Should a cautious holder add more LINK this week? What are the main risks?"],
  ];

  let info = null;
  let es = null;
  let running = false;
  let run = null; // live run state

  // ------------------------------------------------------------ helpers --
  function toast(msg, err = false) {
    const t = document.createElement("div");
    t.className = "toast" + (err ? " err" : "");
    t.textContent = msg;
    $("toasts").append(t);
    setTimeout(() => t.remove(), err ? 6000 : 2600);
  }
  async function copy(text, label = "Copied") {
    try { await navigator.clipboard.writeText(text); toast(label); } catch { toast("Couldn't copy", true); }
  }
  const whoLabel = () => ((info?.planner || "").startsWith("SERV") ? "SERV" : "Planner");
  const confBar = (c) =>
    `<span class="conf"><span class="track"><i style="width:${Math.round(c * 100)}%"></i></span>${c.toFixed(2)}</span>`;

  // --------------------------------------------------------------- info --
  async function loadInfo() {
    try {
      info = await (await fetch("/api/info")).json();
    } catch {
      $("status").innerHTML = `<span class="pill danger"><span class="dot"></span>server unreachable</span>`;
      return;
    }
    const net = NETWORK_NAME[info.network] || info.network;
    const pills = [];
    if (info.setupError) pills.push(`<span class="pill danger"><span class="dot"></span>setup error</span>`);
    if (info.mainnet && info.payments !== "mock") pills.push(`<span class="pill danger"><span class="dot"></span>MAINNET · real USDC</span>`);
    else pills.push(`<span class="pill ok"><span class="dot"></span>${esc(net)}</span>`);
    if (info.payments === "mock") pills.push(`<span class="pill warn"><span class="dot"></span>mock payments</span>`);
    if (info.planner) pills.push(`<span class="pill hide-md">planner <b>${esc(info.planner.replace("SERV Reasoning", "SERV"))}</b></span>`);
    $("status").innerHTML = pills.join("");

    // wallet
    $("payMode").textContent = info.payments === "mock" ? "mock" : "AgentKit";
    $("payMode").className = "tag " + (info.payments === "mock" ? "amber" : "blue");
    $("bal").innerHTML = info.usdcBalance == null ? "–" : `${Number(info.usdcBalance).toFixed(3)} <small>USDC</small>`;
    if (info.wallet) {
      const ex = EXPLORER[info.network];
      $("addr").innerHTML =
        `<span>${esc(short(info.wallet))}</span>` +
        `<button type="button" title="Copy address" data-copy="${esc(info.wallet)}">${ICON.copy}</button>` +
        (ex && info.payments !== "mock" ? `<a href="${ex}/address/${esc(info.wallet)}" target="_blank" rel="noopener">BaseScan ↗</a>` : "");
    }
    $("walletNote").innerHTML = info.setupError
      ? `<div class="errbox">${esc(info.setupError)}</div>`
      : info.lowBalance
        ? `<div class="warnbox">Low balance. Top up this wallet with USDC on ${esc(net)} before the next run.</div>`
        : "";

    // policy
    const p = info.policy || {};
    $("policy").innerHTML = [
      ["Max budget / question", `$${p.maxBudget}`],
      ["Per-purchase cap", `$${p.perCallCap}`],
      ["Max purchases", p.maxPurchases],
      ["Max steps", p.maxSteps],
      ["Pays only", "the listed seller"],
      ["Token", "USDC"],
    ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");

    // presets
    const max = usd(p.maxBudget || "1");
    const presets = ["0.01", "0.02", "0.05", "0.10", "0.25"].filter((v) => usd(v) <= max);
    $("presets").innerHTML = presets.map((v) => `<button type="button" data-v="${v}" aria-pressed="false">$${v}</button>`).join("");
    if (!$("budget").value) setBudget(info.defaultBudget || presets[0]);
  }

  function setBudget(v) {
    $("budget").value = v;
    document.querySelectorAll("#presets button").forEach((b) => b.setAttribute("aria-pressed", String(usd(b.dataset.v) === usd(v))));
  }

  async function loadCatalog() {
    try {
      const c = await (await fetch("/api/catalog")).json();
      if (!c.products) throw new Error(c.error);
      $("prices").innerHTML = c.products.map((x) => `<div><dt>${esc(x.title)}</dt><dd>${esc(x.price)}</dd></div>`).join("") +
        `<div><dt>Symbols</dt><dd>${esc(c.symbols.join(" · "))}</dd></div>`;
    } catch (e) {
      $("prices").innerHTML = `<div><dt class="muted">Seller unreachable</dt><dd></dd></div>`;
    }
  }

  async function loadHistory(activeId) {
    let runs = [];
    try { runs = await (await fetch("/api/runs?limit=30")).json(); } catch {}
    $("hist").innerHTML = runs.length
      ? runs.map((r) => `
        <li><button type="button" data-run="${esc(r.id)}" ${r.id === activeId ? 'aria-current="true"' : ""}>
          <span class="q">${esc(r.question)}</span>
          <span class="m"><span>${esc(r.spent)}</span><span>${r.items} bought</span>${r.blocked ? `<span style="color:var(--red)">${r.blocked} blocked</span>` : ""}${r.payer === "mock" ? "<span>mock</span>" : ""}${r.cancelled ? "<span>stopped</span>" : ""}<span>${new Date(r.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></span>
        </button></li>`).join("")
      : `<li class="empty" style="padding:10px">No runs yet. Your receipts will collect here.</li>`;
  }

  // -------------------------------------------------------------- meter --
  function renderMeter() {
    const r = run;
    const budget = r?.budget || usd($("budget").value) || 0;
    const spent = r ? r.bought.reduce((s, b) => s + usd(b.price), 0) : 0;
    $("mSpent").innerHTML = `${money(spent)} <small id="mOf">of ${money(budget)}</small>`;
    $("mSteps").textContent = r?.steps ?? 0;
    $("mBought").textContent = r?.bought.length ?? 0;
    $("mBlocked").textContent = r?.blocked.length ?? 0;
    const segs = [];
    if (budget > 0 && r) {
      for (const b of r.bought) segs.push(`<i style="width:${(usd(b.price) / budget) * 100}%" title="${esc(b.product)} ${esc(b.price)}"></i>`);
      let left = Math.max(0, budget - spent);
      for (const x of r.blocked) {
        const w = Math.min(usd(x.price), left);
        if (w <= 0) break;
        left -= w;
        segs.push(`<i class="ghost" style="width:${(w / budget) * 100}%" title="blocked: ${esc(x.product)}"></i>`);
      }
    }
    $("bar").innerHTML = segs.join("");
  }

  function tickTime() {
    if (!run) return;
    const ms = (run.finishedMs ?? Date.now()) - run.startMs;
    $("mTime").textContent = (ms / 1000).toFixed(1) + "s";
  }

  // ----------------------------------------------------------- timeline --
  function tlClear() { $("tl").innerHTML = ""; }
  function tlAdd(icon, color, title, bodyHtml = "", cls = "") {
    const li = document.createElement("li");
    if (cls) li.className = cls;
    li.innerHTML = `<div class="ic ${color}">${ICON[icon]}</div><div><div class="ttl">${title}</div>${bodyHtml}</div>`;
    $("tl").append(li);
    li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return li;
  }
  function dropThinking() { document.querySelectorAll("#tl li.thinking").forEach((x) => x.remove()); }

  // -------------------------------------------------------- answer/receipt --
  function renderAnswer(text, confidence, reason) {
    $("answer").className = "text";
    $("answer").style.fontSize = "";
    $("answer").textContent = text;
    $("reason").textContent = reason ? `Why it stopped: ${reason}` : "";
    $("conf").innerHTML = `confidence <span class="track"><i style="width:${Math.round(confidence * 100)}%"></i></span> ${confidence.toFixed(2)}`;
  }

  function renderReceipt(r) {
    const ex = EXPLORER[r.network] || "";
    const rows = [];
    for (const b of r.bought) {
      const proof = b.mock ? `<span class="muted">MOCK</span>` : b.explorerUrl ? `<a href="${esc(b.explorerUrl)}" target="_blank" rel="noopener">tx ${esc(short(b.txHash))} ↗</a>` : "";
      rows.push(`<div class="r-row"><span class="r-item">${esc(b.product)} · ${esc(b.symbol)}</span><span>${esc(b.price)}</span><span class="r-why">${esc(b.reason)}<br>${proof}</span></div>`);
    }
    for (const b of r.blocked)
      rows.push(`<div class="r-row void"><span class="r-item">${esc(b.product)} · ${esc(b.symbol)}</span><span>$0.000</span><span class="r-why" style="color:var(--red)">Blocked: ${esc(b.reason)}</span></div>`);
    for (const n of r.notBought || [])
      rows.push(`<div class="r-row skip"><span class="r-item">${esc(n.product)}</span><span>not bought</span><span class="r-why">${esc(n.why)}</span></div>`);

    const when = new Date(r.finishedAt);
    $("receiptWrap").innerHTML = `
      <div class="receipt">
        <div class="r-head">
          <div class="r-title">Tender</div>
          <div class="r-sub">RECEIPT #${esc(r.id.slice(0, 8).toUpperCase())} · ${esc((NETWORK_NAME[r.network] || r.network).toUpperCase())}${r.payer === "mock" ? " · MOCK" : ""}</div>
          <div class="r-sub">${esc(when.toLocaleDateString())} ${esc(when.toLocaleTimeString())}${r.cancelled ? " · STOPPED" : ""}</div>
        </div>
        <div class="r-row"><span class="r-item" style="font-family:var(--sans);font-size:13.5px">"${esc(r.question)}"</span></div>
        <hr class="r-sep" />
        ${rows.join("") || '<div class="r-row skip"><span>Nothing bought</span><span></span></div>'}
        <hr class="r-sep" />
        <div class="r-row r-total"><span>SPENT</span><span>${esc(r.spent)}</span></div>
        <div class="r-row muted"><span>UNSPENT OF ${esc(r.budget)}</span><span>${esc(r.unspent)}</span></div>
        <div class="r-row muted"><span>STEPS · SERV TOKENS</span><span>${r.steps} · ${r.servTokens.prompt + r.servTokens.completion}</span></div>
        ${r.wallet && ex && r.payer !== "mock" ? `<div class="r-row muted"><span>PAID FROM</span><span><a href="${ex}/address/${esc(r.wallet)}" target="_blank" rel="noopener">${esc(short(r.wallet))}</a></span></div>` : ""}
        <div class="barcode"></div>
        <div class="r-foot">MODEL PROPOSES · CODE DECIDES</div>
      </div>
      <div class="r-actions">
        <a class="btn btn-ghost btn-sm" href="/api/runs/${esc(r.id)}?download" download>Download JSON</a>
        <button class="btn btn-ghost btn-sm" type="button" data-copy-summary>Copy summary</button>
        <button class="btn btn-ghost btn-sm" type="button" data-copy="${location.origin}/app#run=${esc(r.id)}">Copy link</button>
      </div>`;
    $("receiptWrap").querySelector("[data-copy-summary]").onclick = () => copy(summary(r), "Summary copied");
  }

  function summary(r) {
    const lines = [`Tender receipt: "${r.question}"`, ""];
    for (const b of r.bought) lines.push(`+ ${b.product} (${b.symbol}) ${b.price}${b.explorerUrl ? "  " + b.explorerUrl : ""}`);
    for (const b of r.blocked) lines.push(`x ${b.product} (${b.symbol}) blocked: ${b.reason}`);
    lines.push("", `Spent ${r.spent} of ${r.budget} (unspent ${r.unspent})`, "", `Answer: ${r.answer}`);
    return lines.join("\n");
  }

  function renderEvidence(ev) {
    if (!ev?.length) { $("evidenceCard").hidden = true; return; }
    $("evidenceCard").hidden = false;
    $("evidence").innerHTML = ev.map((e, i) => `
      <details class="ev"${i === ev.length - 1 ? " open" : ""}>
        <summary><span><b>${esc(e.product)}</b> · ${esc(e.symbol)} <span class="muted mono" style="font-size:12px">${esc(e.pricePaid)}</span></span></summary>
        <pre>${esc(JSON.stringify(e.data, null, 2))}</pre>
      </details>`).join("");
  }

  // --------------------------------------------------------------- reset --
  function resetView(budget) {
    run = { budget, bought: [], blocked: [], steps: 0, startMs: Date.now(), finishedMs: null };
    tlClear();
    $("viewBanner").innerHTML = "";
    $("answer").className = "text muted";
    $("answer").style.fontSize = "18px";
    $("answer").innerHTML = `<span class="dots">Shopping</span>`;
    $("reason").textContent = "";
    $("conf").innerHTML = "";
    $("receiptWrap").innerHTML = "";
    renderEvidence([]);
    renderMeter();
  }

  function setRunning(on) {
    running = on;
    const go = $("go");
    go.className = on ? "btn btn-danger go" : "btn btn-primary go";
    go.innerHTML = on ? "Stop" : 'Shop <span class="arrow">→</span>';
    go.type = on ? "button" : "submit";
    $("runState").textContent = on ? "running" : "idle";
    $("runState").className = "tag " + (on ? "amber" : "plain");
  }

  // ---------------------------------------------------------------- run --
  function onEvent(e) {
    switch (e.type) {
      case "start":
        run.id = e.id;
        tlAdd("task", "ink", "Task", `<div class="body">${esc(e.question)}</div><div class="meta"><span>budget ${esc(e.budget)}</span><span>cap/purchase ${esc(e.perCallCap)}</span><span>${esc(e.payer === "mock" ? "mock payments" : "x402 · " + (NETWORK_NAME[e.network] || e.network))}</span></div>`);
        break;
      case "catalog":
        tlAdd("list", "ink", "Read the price list <span class='tag plain'>free</span>", `<div class="meta">${e.products.map((p) => `<span>${esc(p.id)} ${esc(p.price)}</span>`).join("")}</div>`);
        break;
      case "thinking":
        dropThinking();
        tlAdd("think", "amber", `<span class="dots">${whoLabel()} is deciding step ${e.step}</span>`, "", "thinking");
        break;
      case "proposal": {
        dropThinking();
        run.steps = e.step;
        const p = e.proposal;
        if (p.action === "buy")
          tlAdd("think", "amber", `${whoLabel()} proposes: buy <span class="mono">${esc(p.product)}</span> · ${esc(p.symbol)} ${confBar(p.confidence)}`, `<div class="why">${esc(p.reason)}</div><div class="meta"><span>step ${e.step}</span><span>${esc(e.model)}</span></div>`);
        else
          tlAdd("answer", "ink", `${whoLabel()} has enough to answer ${confBar(p.confidence)}`, `<div class="why">${esc(p.reason)}</div><div class="meta"><span>step ${e.step}</span></div>`);
        break;
      }
      case "guard":
        if (!e.approved) {
          run.blocked.push({ product: "", price: e.price || "$0" });
          tlAdd("block", "red", `Guard blocked it <span class="tag red">no payment</span>`, `<div class="body">${esc(e.reason)}</div>`);
        } else {
          tlAdd("ok", "green", `Guard approved <span class="mono" style="font-weight:500">${esc(e.price)}</span>`, `<div class="meta"><span>${esc(e.reason)}</span></div>`);
        }
        break;
      case "purchase": {
        const it = e.item;
        run.bought.push(it);
        const proof = it.mock
          ? `<span class="tag amber">mock, no settlement</span>`
          : it.explorerUrl ? `<a href="${esc(it.explorerUrl)}" target="_blank" rel="noopener">${esc(short(it.txHash))} on BaseScan ↗</a>` : "";
        tlAdd("pay", "blue", `${it.mock ? "Paid (mock)" : "Paid over x402"} <span class="mono">${esc(it.price)}</span> USDC`, `<div class="body">${esc(it.product)} · ${esc(it.symbol)}</div><div class="meta">${proof}</div>`);
        break;
      }
      case "purchase_failed":
        tlAdd("err", "red", "Payment failed", `<div class="body">${esc(e.product)}: ${esc(e.error)}</div>`);
        break;
      case "answer":
        dropThinking();
        renderAnswer(e.answer, e.confidence, e.reason);
        break;
      case "receipt":
        run.finishedMs = Date.now();
        renderReceipt(e.receipt);
        renderEvidence(e.receipt.evidence);
        history.replaceState(null, "", `#run=${e.receipt.id}`);
        break;
      case "error":
        dropThinking();
        tlAdd("err", "red", "Error", `<div class="body">${esc(e.message)}</div>`);
        $("answer").className = "text muted";
        $("answer").textContent = "No answer: the run stopped with an error.";
        toast(e.message, true);
        break;
    }
    renderMeter();
  }

  let timer = null;
  function shop() {
    const q = $("q").value.trim();
    const budget = $("budget").value.trim();
    if (!q) return $("q").focus();
    if (!/^\d+(\.\d{1,6})?$/.test(budget) || usd(budget) <= 0) return toast("Enter a budget in USD, like 0.05", true);
    if (info?.policy && usd(budget) > usd(info.policy.maxBudget)) return toast(`Budget is capped at $${info.policy.maxBudget} per question`, true);

    resetView(usd(budget));
    setRunning(true);
    timer = setInterval(tickTime, 100);
    es = new EventSource(`/api/shop?q=${encodeURIComponent(q)}&budget=${encodeURIComponent(budget)}`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "done") return finish();
      onEvent(e);
    };
    es.onerror = () => { if (running) { toast("Connection to the server dropped", true); finish(); } };
  }

  function finish() {
    es?.close();
    es = null;
    clearInterval(timer);
    if (run && !run.finishedMs) run.finishedMs = Date.now();
    tickTime();
    dropThinking();
    setRunning(false);
    loadHistory(run?.id);
    loadInfo();
  }

  function stop() {
    if (!running) return;
    tlAdd("err", "ink", "Stopped by you", `<div class="body">No further purchases. Anything already bought is kept in history.</div>`);
    $("answer").className = "text muted";
    $("answer").textContent = "Stopped before an answer.";
    finish();
    setTimeout(() => loadHistory(run?.id), 1500);
  }

  // ------------------------------------------------------ view old run --
  async function viewRun(id) {
    if (running) return toast("Stop the current run first", true);
    let r;
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error();
      r = await res.json();
    } catch { return toast("Couldn't load that receipt", true); }

    run = {
      id: r.id, budget: usd(r.budget), steps: r.steps,
      bought: r.bought, blocked: r.blocked.map((b) => ({ ...b, price: "$0" })),
      startMs: Date.parse(r.startedAt || r.finishedAt), finishedMs: Date.parse(r.finishedAt),
    };
    tlClear();
    tlAdd("task", "ink", "Task", `<div class="body">${esc(r.question)}</div><div class="meta"><span>budget ${esc(r.budget)}</span><span>${esc(r.planner)}</span></div>`);
    for (const b of r.bought) {
      tlAdd("think", "amber", `Bought <span class="mono">${esc(b.product)}</span> · ${esc(b.symbol)} ${confBar(b.confidenceBefore)}`, `<div class="why">${esc(b.reason)}</div>`);
      tlAdd("pay", "blue", `${b.mock ? "Paid (mock)" : "Paid over x402"} <span class="mono">${esc(b.price)}</span>`, `<div class="meta">${b.explorerUrl ? `<a href="${esc(b.explorerUrl)}" target="_blank" rel="noopener">${esc(short(b.txHash))} on BaseScan ↗</a>` : ""}</div>`);
    }
    for (const b of r.blocked)
      tlAdd("block", "red", `Guard blocked <span class="mono">${esc(b.product)}</span> · ${esc(b.symbol)}`, `<div class="body">${esc(b.reason)}</div><div class="why">${esc(b.modelReason)}</div>`);
    tlAdd("answer", "ink", `Answered ${confBar(r.confidence)}`);

    $("viewBanner").innerHTML = `<div class="banner">Viewing a saved receipt from ${esc(new Date(r.finishedAt).toLocaleString())}. <button class="btn btn-ghost btn-sm" type="button" id="backLive">New question</button></div>`;
    $("backLive").onclick = newRun;
    renderAnswer(r.answer, r.confidence, "");
    renderReceipt(r);
    renderEvidence(r.evidence);
    renderMeter();
    tickTime();
    $("q").value = r.question;
    history.replaceState(null, "", `#run=${r.id}`);
    loadHistory(r.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function newRun() {
    if (running) return;
    run = null;
    history.replaceState(null, "", "/app");
    $("viewBanner").innerHTML = "";
    $("q").value = "";
    $("q").focus();
    loadHistory();
  }

  // ------------------------------------------------------------- wiring --
  $("examples").innerHTML = EXAMPLES.map(([t, q]) => `<button type="button" data-q="${esc(q)}"><span class="t">${t}</span>${esc(q)}</button>`).join("");

  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("button, a");
    if (!t) return;
    if (t.dataset.q) { $("q").value = t.dataset.q; $("q").focus(); autosize(); }
    else if (t.dataset.v) setBudget(t.dataset.v);
    else if (t.dataset.run) viewRun(t.dataset.run);
    else if (t.dataset.copy) copy(t.dataset.copy, t.dataset.copy.startsWith("0x") ? "Address copied" : "Link copied");
    else if (t.id === "go" && running) stop();
    else if (t.id === "newRun") newRun();
  });

  $("form").addEventListener("submit", (ev) => { ev.preventDefault(); if (!running) shop(); });
  $("budget").addEventListener("input", () => setBudget($("budget").value));

  const autosize = () => { const t = $("q"); t.style.height = "auto"; t.style.height = Math.min(180, t.scrollHeight) + "px"; };
  $("q").addEventListener("input", autosize);
  $("q").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); if (!running) shop(); }
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") stop(); });

  // boot
  renderMeter();
  loadInfo();
  loadCatalog();
  const m = location.hash.match(/run=([\w-]+)/);
  loadHistory(m?.[1]);
  if (m) viewRun(m[1]);
})();
