/**
 * Dashboard controller.
 *
 * One `refresh()` fans out to the four read endpoints with `Promise.allSettled`,
 * so a single failing route degrades exactly one section to an "unavailable"
 * state instead of stopping the poll loop. Polling pauses while the tab is
 * hidden — the cron scanner keeps working regardless, and a backgrounded tab
 * hammering D1 every 5s buys nothing.
 *
 * No bundler, no framework, no external assets: this file is loaded directly by
 * `index.html` and must stay valid in the browser as written.
 */
(() => {
  "use strict";

  const POLL_MS = 5000;
  const OPPS_LIMIT = 30;
  const TRADES_LIMIT = 30;
  const SCANS_LIMIT = 15;
  const TOAST_MS = 6000;

  // -- tiny helpers ---------------------------------------------------------

  /** @param {string} id */
  const $ = (id) => document.getElementById(id);

  const HTML_ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  /**
   * Escape a value for interpolation into `innerHTML`. Every server-provided
   * string (cycle labels, sources, error text, trigger names) goes through this.
   */
  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  }

  const isNum = (n) => typeof n === "number" && Number.isFinite(n);

  /** Fixed-decimal number with thousands separators; `—` for anything unusable. */
  function fmtNum(n, digits = 2) {
    if (!isNum(n)) return "—";
    return n.toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  /** Signed number, e.g. `+12.34` / `-0.50`. */
  function fmtSigned(n, digits = 2) {
    if (!isNum(n)) return "—";
    return (n > 0 ? "+" : "") + fmtNum(n, digits);
  }

  function fmtPct(n, digits = 4) {
    if (!isNum(n)) return "—";
    return (n > 0 ? "+" : "") + fmtNum(n, digits) + "%";
  }

  /**
   * Asset amounts span ~1e-6 (BTC) to ~1e4 (USDT), so a fixed decimal count is
   * either noise or a lie. Small magnitudes get significant digits instead.
   */
  function fmtAmount(n) {
    if (!isNum(n)) return "—";
    const abs = Math.abs(n);
    if (abs !== 0 && abs < 1) return String(Number(n.toPrecision(6)));
    return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
  }

  function fmtPrice(n) {
    if (!isNum(n)) return "—";
    const abs = Math.abs(n);
    if (abs !== 0 && abs < 1) return String(Number(n.toPrecision(8)));
    return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
  }

  /** Wall-clock time of a timestamp, for the leftmost column of every table. */
  function fmtClock(ts) {
    if (!isNum(ts)) return "—";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString("en-GB", { hour12: false });
  }

  /** `"42s ago"`, `"5m ago"`, `"2h ago"`, `"3d ago"`. */
  function fmtRelative(ts, now = Date.now()) {
    if (!isNum(ts)) return "—";
    const secs = Math.round((now - ts) / 1000);
    if (secs < 0) return "just now";
    if (secs < 5) return "just now";
    if (secs < 60) return secs + "s ago";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + "m ago";
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h ago";
    return Math.floor(hours / 24) + "d ago";
  }

  /** CSS class for a signed figure; zero stays neutral. */
  function signClass(n) {
    if (!isNum(n) || n === 0) return "flat";
    return n > 0 ? "up" : "down";
  }

  // -- fetch ----------------------------------------------------------------

  /**
   * Fetch JSON, normalising both transport failures and the API's single
   * `{ error }` failure shape into one thrown `Error`.
   */
  async function getJson(url, init) {
    const res = await fetch(url, init);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const detail = body && typeof body.error === "string" ? body.error : "HTTP " + res.status;
      throw new Error(detail);
    }
    if (body && typeof body.error === "string" && body.error && !("scanId" in body)) {
      throw new Error(body.error);
    }
    return body;
  }

  // -- toasts ---------------------------------------------------------------

  function toast(message, kind = "info") {
    const host = $("toasts");
    if (!host) return;
    const node = document.createElement("div");
    node.className = "toast toast-" + kind;
    node.textContent = message;
    host.appendChild(node);
    setTimeout(() => {
      node.classList.add("toast-out");
      setTimeout(() => node.remove(), 300);
    }, TOAST_MS);
  }

  // -- rendering: portfolio -------------------------------------------------

  function renderPortfolio(p) {
    $("stat-equity").textContent = fmtNum(p.equityUsdt, 2);

    const abs = p.pnl ? p.pnl.absUsdt : NaN;
    const pct = p.pnl ? p.pnl.pct : NaN;

    const absEl = $("stat-pnl-abs");
    absEl.textContent = fmtSigned(abs, 2);
    absEl.className = "stat-value num " + signClass(abs);

    const pctEl = $("stat-pnl-pct");
    pctEl.textContent = fmtPct(pct, 3);
    pctEl.className = "stat-value num " + signClass(pct);

    const balances = Array.isArray(p.balances) ? p.balances : [];
    $("balances-line").textContent = balances.length
      ? balances.map((b) => fmtAmount(b.amount) + " " + b.asset).join("   ·   ")
      : "none";

    $("portfolio-note").textContent = "initial " + fmtNum(p.initialUsdt, 2) + " USDT";
    $("portfolio-note").classList.remove("bad");
  }

  function portfolioUnavailable(reason) {
    for (const id of ["stat-equity", "stat-pnl-abs", "stat-pnl-pct"]) {
      const el = $(id);
      el.textContent = "—";
      el.className = "stat-value num flat";
    }
    $("balances-line").textContent = "unavailable";
    const note = $("portfolio-note");
    note.textContent = "unavailable — " + reason;
    note.classList.add("bad");
  }

  // -- rendering: tables ----------------------------------------------------

  /** One full-width message row (loading / empty / unavailable). */
  function placeholder(body, span, text, muted = true) {
    body.innerHTML =
      '<tr class="placeholder-row' +
      (muted ? "" : " bad") +
      '"><td colspan="' +
      span +
      '">' +
      esc(text) +
      "</td></tr>";
  }

  function legsTable(legs) {
    if (!Array.isArray(legs) || legs.length === 0) {
      return '<p class="legs-empty">No leg detail recorded.</p>';
    }
    const rows = legs
      .map(
        (leg, i) =>
          "<tr><td>" +
          (i + 1) +
          '</td><td class="mono">' +
          esc(leg.pair) +
          '</td><td><span class="side side-' +
          (leg.side === "BUY" ? "buy" : "sell") +
          '">' +
          esc(leg.side) +
          '</span></td><td class="right num">' +
          fmtPrice(leg.price) +
          '</td><td class="right num">' +
          fmtAmount(leg.inAmount) +
          " " +
          esc(leg.inAsset) +
          '</td><td class="right num">' +
          fmtAmount(leg.outAmount) +
          " " +
          esc(leg.outAsset) +
          "</td></tr>",
      )
      .join("");

    return (
      '<table class="legs"><thead><tr><th>#</th><th>Pair</th><th>Side</th>' +
      '<th class="right">Price</th><th class="right">In</th><th class="right">Out</th>' +
      "</tr></thead><tbody>" +
      rows +
      "</tbody></table>"
    );
  }

  function renderOpportunities(list) {
    const body = $("opps-body");
    if (list.length === 0) {
      placeholder(body, 6, "No opportunities yet — run a scan.");
      return;
    }

    const open = openLegRows(body);
    const now = Date.now();

    body.innerHTML = list
      .map((o) => {
        const key = "op-" + o.id;
        const expanded = open.has(key);
        return (
          '<tr class="data-row" data-key="' +
          esc(key) +
          '">' +
          '<td class="col-toggle"><button type="button" class="row-toggle" data-toggle="' +
          esc(key) +
          '" aria-expanded="' +
          (expanded ? "true" : "false") +
          '" aria-label="Toggle legs for ' +
          esc(o.cycle) +
          '"><span aria-hidden="true">' +
          (expanded ? "▾" : "▸") +
          "</span></button></td>" +
          '<td class="num nowrap"><span title="' +
          esc(new Date(o.ts).toISOString()) +
          '">' +
          fmtClock(o.ts) +
          '</span> <span class="ago">' +
          esc(fmtRelative(o.ts, now)) +
          "</span></td>" +
          '<td class="mono">' +
          esc(o.cycle) +
          "</td>" +
          '<td class="right num ' +
          signClass(o.grossPct) +
          '">' +
          fmtPct(o.grossPct) +
          "</td>" +
          '<td class="right num ' +
          signClass(o.netPct) +
          '">' +
          fmtPct(o.netPct) +
          "</td>" +
          "<td>" +
          (o.executed
            ? '<span class="tag tag-exec">executed</span>'
            : '<span class="tag tag-skip">—</span>') +
          "</td>" +
          "</tr>" +
          '<tr class="legs-row" data-legs="' +
          esc(key) +
          '"' +
          (expanded ? "" : " hidden") +
          '><td colspan="6">' +
          legsTable(o.legs) +
          "</td></tr>"
        );
      })
      .join("");

    $("opps-note").textContent = "newest " + list.length;
    $("opps-note").classList.remove("bad");
  }

  /** Keys of leg rows currently expanded, so a re-render does not collapse them. */
  function openLegRows(body) {
    const open = new Set();
    for (const row of body.querySelectorAll("tr.legs-row:not([hidden])")) {
      const key = row.getAttribute("data-legs");
      if (key) open.add(key);
    }
    return open;
  }

  function renderTrades(list) {
    const body = $("trades-body");
    if (list.length === 0) {
      placeholder(body, 5, "No trades booked yet.");
      return;
    }
    const now = Date.now();

    body.innerHTML = list
      .map(
        (t) =>
          '<tr class="data-row">' +
          '<td class="num nowrap"><span title="' +
          esc(new Date(t.ts).toISOString()) +
          '">' +
          fmtClock(t.ts) +
          '</span> <span class="ago">' +
          esc(fmtRelative(t.ts, now)) +
          "</span></td>" +
          '<td class="mono">' +
          esc(t.cycle) +
          "</td>" +
          '<td class="right num nowrap">' +
          fmtNum(t.startAmount, 2) +
          ' <span class="arrow" aria-hidden="true">→</span> ' +
          fmtNum(t.endAmount, 2) +
          "</td>" +
          '<td class="right num ' +
          signClass(t.profit) +
          '">' +
          fmtSigned(t.profit, 4) +
          "</td>" +
          '<td class="right num ' +
          signClass(t.profitPct) +
          '">' +
          fmtPct(t.profitPct) +
          "</td>" +
          "</tr>",
      )
      .join("");
  }

  function renderScans(list) {
    const body = $("scans-body");
    if (list.length === 0) {
      placeholder(body, 8, "No scans recorded yet.");
      return;
    }
    const now = Date.now();

    body.innerHTML = list
      .map(
        (s) =>
          '<tr class="data-row">' +
          '<td class="num nowrap"><span title="' +
          esc(new Date(s.ts).toISOString()) +
          '">' +
          fmtClock(s.ts) +
          '</span> <span class="ago">' +
          esc(fmtRelative(s.ts, now)) +
          "</span></td>" +
          '<td><span class="tag">' +
          esc(s.trigger) +
          "</span></td>" +
          '<td class="mono">' +
          (s.source ? esc(s.source) : '<span class="ago">—</span>') +
          "</td>" +
          '<td class="right num">' +
          (isNum(s.pairs_count) ? s.pairs_count : "—") +
          "</td>" +
          '<td class="right num">' +
          (isNum(s.triangles_count) ? s.triangles_count : "—") +
          "</td>" +
          '<td class="right num ' +
          signClass(s.best_net_pct) +
          '">' +
          (isNum(s.best_net_pct) ? fmtPct(s.best_net_pct) : "—") +
          "</td>" +
          '<td class="right num">' +
          (isNum(s.duration_ms) ? s.duration_ms + " ms" : "—") +
          "</td>" +
          '<td class="err">' +
          (s.error ? esc(s.error) : "") +
          "</td>" +
          "</tr>",
      )
      .join("");
  }

  /** Header badge + age line, both driven by the newest scan row. */
  function renderStatus(scans) {
    const badge = $("source-badge");
    const age = $("scan-age");
    const latest = scans[0];

    if (!latest) {
      badge.textContent = "no scans yet";
      badge.dataset.state = "idle";
      age.textContent = "—";
      return;
    }

    if (latest.error) {
      badge.textContent = "error";
      badge.dataset.state = "error";
      badge.title = latest.error;
    } else if (latest.source) {
      badge.textContent = latest.source;
      badge.dataset.state = latest.source === "binance-ws" ? "ok" : "warn";
      badge.title = "Data source of the latest scan";
    } else {
      badge.textContent = "pending";
      badge.dataset.state = "idle";
      badge.title = "Scan recorded no source";
    }

    age.textContent = "last scan " + fmtRelative(latest.ts);
  }

  // -- settings -------------------------------------------------------------

  const SETTING_INPUTS = {
    min_profit_pct: "set-min-profit",
    trade_size_usdt: "set-trade-size",
    fee_rate: "set-fee-rate",
  };

  function applySettings(s) {
    for (const [key, id] of Object.entries(SETTING_INPUTS)) {
      const input = $(id);
      // Never stomp on a field the operator is mid-edit.
      if (document.activeElement === input) continue;
      input.value = isNum(s[key]) ? String(s[key]) : "";
    }
    $("settings-summary").textContent =
      "min " + s.min_profit_pct + "% · size " + s.trade_size_usdt + " USDT · fee " + s.fee_rate;
    settingsError("");
  }

  function settingsError(message) {
    const el = $("settings-error");
    el.textContent = message;
    el.hidden = !message;
  }

  async function loadSettings() {
    try {
      applySettings(await getJson("/api/settings"));
    } catch (err) {
      $("settings-summary").textContent = "unavailable";
      settingsError("Could not load settings: " + err.message);
    }
  }

  async function saveSetting(input) {
    const key = input.dataset.setting;
    const value = Number(input.value);
    if (input.value.trim() === "" || !Number.isFinite(value)) {
      settingsError(key + " must be a finite number");
      return;
    }
    settingsError("");
    input.disabled = true;
    try {
      const updated = await getJson("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      input.disabled = false;
      applySettings(updated);
      toast("Saved " + key + " = " + value, "ok");
    } catch (err) {
      input.disabled = false;
      settingsError(err.message);
      toast("Settings rejected: " + err.message, "error");
      // Snap the field back to the value the server actually holds.
      loadSettings();
    }
  }

  // -- actions --------------------------------------------------------------

  async function doScan() {
    const btn = $("scan-btn");
    btn.disabled = true;
    btn.classList.add("busy");
    const original = btn.textContent;
    btn.textContent = "Scanning…";
    try {
      const r = await getJson("/api/scan", { method: "POST" });
      if (r.skipped) {
        toast("Scan skipped: " + (r.error || "another scan is in progress"), "warn");
      } else if (r.error) {
        toast("Scan failed: " + r.error, "error");
      } else {
        const best = isNum(r.bestNetPct) ? fmtPct(r.bestNetPct) : "n/a";
        toast(
          "Scan " +
            (r.source || "unknown") +
            " · " +
            r.trianglesCount +
            " triangles · best " +
            best +
            (r.executed ? " · trade executed" : "") +
            " · " +
            r.durationMs +
            "ms",
          r.executed ? "ok" : "info",
        );
      }
    } catch (err) {
      toast("Scan failed: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.classList.remove("busy");
      btn.textContent = original;
      refresh();
    }
  }

  async function doReset() {
    const ok = window.confirm(
      "Reset the paper portfolio and wipe ALL history (trades, opportunities, scans)?\n\n" +
        "Settings are kept. This cannot be undone.",
    );
    if (!ok) return;

    const btn = $("reset-btn");
    btn.disabled = true;
    try {
      const r = await getJson("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wipeHistory: true }),
      });
      toast("Reset complete — equity " + fmtNum(r.equityUsdt, 2) + " USDT", "ok");
    } catch (err) {
      toast("Reset failed: " + err.message, "error");
    } finally {
      btn.disabled = false;
      refresh();
    }
  }

  // -- poll loop ------------------------------------------------------------

  let timer = null;
  let inFlight = false;

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
      const [portfolio, opps, trades, scans] = await Promise.allSettled([
        getJson("/api/portfolio"),
        getJson("/api/opportunities?limit=" + OPPS_LIMIT),
        getJson("/api/trades?limit=" + TRADES_LIMIT),
        getJson("/api/scans?limit=" + SCANS_LIMIT),
      ]);

      if (portfolio.status === "fulfilled") renderPortfolio(portfolio.value);
      else portfolioUnavailable(portfolio.reason.message);

      if (opps.status === "fulfilled") {
        renderOpportunities(opps.value.opportunities || []);
      } else {
        placeholder($("opps-body"), 6, "unavailable — " + opps.reason.message, false);
      }

      if (trades.status === "fulfilled") {
        const list = trades.value.trades || [];
        renderTrades(list);
        $("stat-trades").textContent = String(list.length);
        $("stat-trades-unit").textContent =
          list.length >= TRADES_LIMIT ? "booked (newest " + TRADES_LIMIT + ")" : "booked";
      } else {
        placeholder($("trades-body"), 5, "unavailable — " + trades.reason.message, false);
        $("stat-trades").textContent = "—";
      }

      if (scans.status === "fulfilled") {
        const list = scans.value.scans || [];
        renderScans(list);
        renderStatus(list);
      } else {
        placeholder($("scans-body"), 8, "unavailable — " + scans.reason.message, false);
      }
    } finally {
      inFlight = false;
    }
  }

  function startPolling() {
    if (timer !== null) return;
    timer = setInterval(refresh, POLL_MS);
  }

  function stopPolling() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  // -- wiring ---------------------------------------------------------------

  function init() {
    $("scan-btn").addEventListener("click", doScan);
    $("reset-btn").addEventListener("click", doReset);

    // Delegated: table bodies are replaced wholesale on every render, so
    // per-row listeners would leak with them.
    $("opps-body").addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-toggle]");
      if (!btn) return;
      const key = btn.getAttribute("data-toggle");
      const row = document.querySelector('tr.legs-row[data-legs="' + CSS.escape(key) + '"]');
      if (!row) return;
      const nowHidden = !row.hidden;
      row.hidden = nowHidden;
      btn.setAttribute("aria-expanded", nowHidden ? "false" : "true");
      btn.firstElementChild.textContent = nowHidden ? "▸" : "▾";
    });

    for (const id of Object.values(SETTING_INPUTS)) {
      $(id).addEventListener("change", (event) => saveSetting(event.target));
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopPolling();
      } else {
        refresh();
        startPolling();
      }
    });

    loadSettings();
    refresh();
    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
