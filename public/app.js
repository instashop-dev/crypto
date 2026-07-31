/**
 * Dashboard controller.
 *
 * One `refresh()` fans out to the five read endpoints with `Promise.allSettled`,
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
  /**
   * Funding rows rendered.
   *
   * The other listings are capped server-side by `?limit=`; `/api/funding`
   * serves one whole board and has no such parameter, because "the newest
   * board" is a single poll's worth of rows and truncating it in SQL would make
   * the count reported beside it a lie. Since Phase 14 that board is up to four
   * venues wide, so the cap moved here — a display budget, applied after the
   * server has ranked, exactly like the 30 on spreads and trades.
   */
  const FUNDING_LIMIT = 40;
  /** Closed carry positions requested. Sparse by construction — a handful of
   *  slots each held for days — so 30 is already months of book. */
  const CARRY_LIMIT = 30;
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

  /**
   * `"7h 42m"`, `"42m 10s"`, `"38s"` — time remaining, counting down.
   *
   * Recomputed from the stored timestamp on every 5s poll rather than driven by
   * a timer of its own: a second interval would add a second thing that can
   * drift, for a figure nobody reads to the second. Past due reads `"due"`,
   * because a settlement that has already fired is not a negative wait.
   */
  function fmtCountdown(ms) {
    if (!isNum(ms)) return "—";
    if (ms <= 0) return "due";
    const secs = Math.floor(ms / 1000);
    const hours = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    if (hours > 0) return hours + "h " + mins + "m";
    if (mins > 0) return mins + "m " + (secs % 60) + "s";
    return secs + "s";
  }

  /** `"3d 4h"`, `"4h 12m"`, `"12m"` — an elapsed duration, counting up. */
  function fmtDuration(ms) {
    if (!isNum(ms) || ms < 0) return "—";
    const mins = Math.floor(ms / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    if (days > 0) return days + "d " + hours + "h";
    if (hours > 0) return hours + "h " + (mins % 60) + "m";
    return mins + "m";
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

  // -- india mode -----------------------------------------------------------

  /**
   * Whether the last portfolio poll reported india mode on.
   *
   * Held at module scope because three unrelated renderers key off it — the
   * tax stat row, the header badge and the trades table's column count — and
   * they do not all run from the same response. `/api/portfolio` is the single
   * source of truth: the settings panel can be mid-edit, the server's answer
   * cannot.
   */
  let indiaMode = false;

  /** Columns in the trades table: 6 normally, 8 with the TDS and Net columns. */
  const TRADES_COLS = () => (indiaMode ? 8 : 6);
  /** Columns in the spreads and scans tables. Fixed, unlike trades. */
  const OPPS_COLS = 7;
  const SCANS_COLS = 8;
  const FUNDING_COLS = 8;
  const CARRY_OPEN_COLS = 8;
  const CARRY_CLOSED_COLS = 9;

  function setIndiaMode(on) {
    indiaMode = Boolean(on);
    $("tax-stats").hidden = !indiaMode;
    $("india-badge").hidden = !indiaMode;
    $("th-trades-tds").hidden = !indiaMode;
    $("th-trades-net").hidden = !indiaMode;
  }

  // -- strategy -------------------------------------------------------------

  /**
   * Row badges. `triangular` is **historical** — that strategy was deleted, so
   * the label only ever appears on rows written before it was, and the table
   * would be unreadable without it.
   */
  const STRATEGY_LABELS = {
    triangular: "tri",
    cross_exchange: "x-chg",
  };

  /** Badge for a row's strategy; unknown values render verbatim, not blank. */
  function strategyTag(strategy) {
    const known = strategy === "triangular" || strategy === "cross_exchange";
    const cls = strategy === "cross_exchange" ? "tag-xchg" : "tag-tri";
    const text = known ? STRATEGY_LABELS[strategy] : strategy || "—";
    return (
      '<span class="tag ' +
      (known ? cls : "tag-skip") +
      '" title="' +
      esc(strategy || "unknown") +
      '">' +
      esc(text) +
      "</span>"
    );
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

    const tax = p.tax || {};
    setIndiaMode(tax.indiaMode);
    if (indiaMode) {
      // Net P&L and net equity are signed against the initial balance; the two
      // tax figures are magnitudes, so they stay neutral rather than pretending
      // that "more withheld" is a gain.
      const net = tax.netProfitUsdt;
      const netEl = $("stat-tax-net");
      netEl.textContent = fmtSigned(net, 4);
      netEl.className = "stat-value num " + signClass(net);

      $("stat-tax-tds").textContent = fmtNum(tax.tdsWithheldUsdt, 4);
      $("stat-tax-tds").className = "stat-value num flat";
      $("stat-tax-due").textContent = fmtNum(tax.taxDueUsdt, 4);
      $("stat-tax-due").className = "stat-value num flat";

      const equityDelta = isNum(tax.netEquityUsdt) && isNum(p.initialUsdt)
        ? tax.netEquityUsdt - p.initialUsdt
        : NaN;
      const eqEl = $("stat-tax-equity");
      eqEl.textContent = fmtNum(tax.netEquityUsdt, 2);
      eqEl.className = "stat-value num " + signClass(equityDelta);
    }
  }

  const TAX_STAT_IDS = ["stat-tax-net", "stat-tax-tds", "stat-tax-due", "stat-tax-equity"];

  function portfolioUnavailable(reason) {
    for (const id of ["stat-equity", "stat-pnl-abs", "stat-pnl-pct", ...TAX_STAT_IDS]) {
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
    // A spread's venue *is* the trade, so the column is shown — but historical
    // triangular rows carry no venue on their legs (all three executed on one
    // book), and an empty column there would be noise.
    const withVenue = legs.some((leg) => leg && leg.venue);

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
          "</span></td>" +
          (withVenue ? '<td class="mono">' + esc(leg.venue || "—") + "</td>" : "") +
          '<td class="right num">' +
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
      (withVenue ? "<th>Venue</th>" : "") +
      '<th class="right">Price</th><th class="right">In</th><th class="right">Out</th>' +
      "</tr></thead><tbody>" +
      rows +
      "</tbody></table>"
    );
  }

  /**
   * The spreads table.
   *
   * `qualifies` arrives from the server, already judged against the *current*
   * `xchg_min_profit_pct`, so the badge never disagrees with the settings panel
   * — exactly as the funding board does with its own threshold. It replaced an
   * "executed" column when Phase 12 removed the fill paths.
   */
  function renderOpportunities(list, minProfitPct) {
    const body = $("opps-body");
    if (list.length === 0) {
      placeholder(body, OPPS_COLS, "No spreads recorded yet — run a scan.");
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
          "<td>" +
          strategyTag(o.strategy) +
          "</td>" +
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
          (o.qualifies
            ? '<span class="tag tag-exec">qualifies</span>'
            : '<span class="tag tag-skip">—</span>') +
          "</td>" +
          "</tr>" +
          '<tr class="legs-row" data-legs="' +
          esc(key) +
          '"' +
          (expanded ? "" : " hidden") +
          '><td colspan="' +
          OPPS_COLS +
          '">' +
          legsTable(o.legs) +
          "</td></tr>"
        );
      })
      .join("");

    $("opps-note").textContent =
      "newest " + list.length + (isNum(minProfitPct) ? " · min " + minProfitPct + "%" : "");
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
      placeholder(body, TRADES_COLS(), "No trades booked yet.");
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
          "<td>" +
          strategyTag(t.strategy) +
          "</td>" +
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
          (indiaMode
            ? // TDS is always a debit, so it is rendered negative even though
              // the stored figure is a magnitude.
              '<td class="right num ' +
              (isNum(t.tdsWithheld) && t.tdsWithheld > 0 ? "down" : "flat") +
              '">' +
              (isNum(t.tdsWithheld) ? fmtSigned(-t.tdsWithheld, 4) : "—") +
              "</td>" +
              '<td class="right num ' +
              signClass(t.netProfit) +
              '">' +
              fmtSigned(t.netProfit, 4) +
              "</td>"
            : "") +
          "</tr>",
      )
      .join("");
  }

  function renderScans(list) {
    const body = $("scans-body");
    if (list.length === 0) {
      placeholder(body, SCANS_COLS, "No scans recorded yet.");
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
          (isNum(s.spreads_count) ? s.spreads_count : "—") +
          "</td>" +
          '<td class="right num ' +
          signClass(s.best_spread_net_pct) +
          '">' +
          (isNum(s.best_spread_net_pct) ? fmtPct(s.best_spread_net_pct) : "—") +
          "</td>" +
          '<td class="right num">' +
          (isNum(s.duration_ms) ? s.duration_ms + " ms" : "—") +
          "</td>" +
          // A cross-exchange failure is a degraded scan, not a failed one, so
          // it shares the column but stays visually muted.
          '<td class="err">' +
          (s.error ? esc(s.error) : "") +
          (s.xchg_error
            ? '<span class="ago">' +
              (s.error ? " · " : "") +
              "x-chg: " +
              esc(s.xchg_error) +
              "</span>"
            : "") +
          "</td>" +
          "</tr>",
      )
      .join("");
  }

  /**
   * The funding board.
   *
   * `qualifies` arrives from the server, already judged against the *current*
   * threshold, so the badge never disagrees with the settings panel next to it.
   * Everything else the row shows is stored, including the interval — which is
   * flagged when it was assumed rather than published, because the annualised
   * column scales linearly with it.
   */
  function renderFunding(data) {
    const body = $("funding-body");
    const note = $("funding-note");
    const rates = Array.isArray(data.rates) ? data.rates : [];

    if (rates.length === 0) {
      placeholder(body, FUNDING_COLS, "No funding rates yet — run a scan.");
      note.textContent = "—";
      note.classList.remove("bad");
      return;
    }

    const now = Date.now();
    const shown = rates.slice(0, FUNDING_LIMIT);
    body.innerHTML = shown
      .map((r) => {
        const assumed = r.intervalSource !== "api";
        const hours = isNum(r.intervalMinutes) ? r.intervalMinutes / 60 : NaN;
        const interval = isNum(hours)
          ? (Number.isInteger(hours) ? hours : Number(hours.toFixed(2))) + "h"
          : "—";
        const countdown = isNum(r.nextFundingTs)
          ? fmtCountdown(r.nextFundingTs - now)
          : "—";

        return (
          '<tr class="data-row">' +
          '<td class="mono"><span title="' +
          esc(r.instrument || r.symbol) +
          '">' +
          esc(r.symbol) +
          "</span></td>" +
          '<td class="mono">' +
          esc(r.venue) +
          "</td>" +
          // The per-interval rate itself, in percent: 0.0001 -> +0.0100%.
          '<td class="right num ' +
          signClass(r.rate) +
          '">' +
          fmtPct(isNum(r.rate) ? r.rate * 100 : NaN, 4) +
          "</td>" +
          '<td class="right num nowrap">' +
          (assumed
            ? '<span class="ago" title="Assumed — this venue did not publish a' +
              ' settlement interval, so the annualised figures below scale off a' +
              ' guess.">' +
              esc(interval) +
              " *</span>"
            : esc(interval)) +
          "</td>" +
          '<td class="right num ' +
          signClass(r.annualizedPct) +
          '">' +
          fmtPct(r.annualizedPct, 2) +
          "</td>" +
          '<td class="right num ' +
          signClass(r.netAnnualPct) +
          '">' +
          fmtPct(r.netAnnualPct, 2) +
          "</td>" +
          '<td class="right num nowrap">' +
          esc(countdown) +
          "</td>" +
          "<td>" +
          (r.qualifies
            ? '<span class="tag tag-exec">qualifies</span>'
            : '<span class="tag tag-skip">—</span>') +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    // Every venue that contributed, with its share of the board: since Phase 14
    // the poll is fetch-all, so naming one source would hide a venue that has
    // been dead for a week behind the three that are not.
    const venues = Array.isArray(data.venues) && data.venues.length > 0
      ? data.venues.map((v) => esc(v.venue) + " " + v.count).join(" + ")
      : data.venue
        ? esc(data.venue)
        : "unknown";
    const age = isNum(data.ts) ? fmtRelative(data.ts, now) : "—";
    note.textContent =
      venues +
      " · " +
      (shown.length < rates.length ? "top " + shown.length + " of " : "") +
      rates.length +
      " perps · min " +
      (isNum(data.minAnnualPct) ? data.minAnnualPct : "—") +
      "% · " +
      (isNum(data.holdDays) ? data.holdDays : "—") +
      "d hold · updated " +
      age +
      (data.stale ? " (stale)" : "");
    note.classList.toggle("bad", Boolean(data.stale));
  }

  /** Close reasons, shortened for the table. Unknown values render verbatim. */
  const CLOSE_REASONS = {
    max_hold: "max hold",
    rate_below_exit: "rate < exit",
    stale_data: "stale data",
    manual: "manual",
  };

  /**
   * The carry book: open positions above, closed ones below.
   *
   * The column that matters is the last one — realised annual % less predicted
   * annual %. A negative number is the entry rate having over-promised, which is
   * exactly what `src/engine/funding.ts` warns it will do; the panel exists to
   * put a size on that rather than to repeat the warning.
   */
  function renderCarry(data) {
    const openBody = $("carry-open-body");
    const closedBody = $("carry-closed-body");
    const note = $("carry-note");
    const open = Array.isArray(data.open) ? data.open : [];
    const closed = Array.isArray(data.closed) ? data.closed : [];
    const summary = data.summary || {};
    const settings = data.settings || {};
    const now = Date.now();

    if (open.length === 0) {
      placeholder(
        openBody,
        CARRY_OPEN_COLS,
        settings.enabled === false
          ? "No open positions — funding_positions_enabled is off."
          : "No open positions.",
      );
    } else {
      openBody.innerHTML = open
        .map(
          (p) =>
            '<tr class="data-row">' +
            '<td class="mono"><span title="' +
            esc(p.instrument || p.symbol) +
            '">' +
            esc(p.symbol) +
            "</span></td>" +
            '<td class="mono">' +
            esc(p.venue) +
            "</td>" +
            '<td class="right num">' +
            fmtNum(p.notionalUsdt, 2) +
            "</td>" +
            '<td class="right num ' +
            signClass(p.predictedNetAnnualPct) +
            '">' +
            fmtPct(p.predictedNetAnnualPct, 2) +
            "</td>" +
            '<td class="right num ' +
            signClass(p.accruedFundingUsdt) +
            '">' +
            fmtSigned(p.accruedFundingUsdt, 4) +
            "</td>" +
            // Settlements observed, not settlements elapsed: the two differ by
            // exactly the boundaries that had no rate row behind them.
            '<td class="right num">' +
            (isNum(p.accrualCount) ? p.accrualCount : "—") +
            "</td>" +
            '<td class="right num nowrap">' +
            esc(fmtDuration(now - p.entryTs)) +
            "</td>" +
            '<td class="right"><button type="button" class="btn-row"' +
            ' data-close-position="' +
            esc(p.id) +
            '">close</button></td>' +
            "</tr>",
        )
        .join("");
    }

    if (closed.length === 0) {
      placeholder(closedBody, CARRY_CLOSED_COLS, "Nothing has closed yet.");
    } else {
      closedBody.innerHTML = closed
        .map((p) => {
          const error =
            isNum(p.realizedAnnualPct) && isNum(p.predictedNetAnnualPct)
              ? p.realizedAnnualPct - p.predictedNetAnnualPct
              : NaN;
          const reason = CLOSE_REASONS[p.closeReason] || p.closeReason || "—";
          const held =
            isNum(p.closeTs) && isNum(p.entryTs) ? p.closeTs - p.entryTs : NaN;

          return (
            '<tr class="data-row">' +
            '<td class="num nowrap"><span title="' +
            esc(new Date(p.closeTs).toISOString()) +
            '">' +
            fmtClock(p.closeTs) +
            '</span> <span class="ago">' +
            esc(fmtRelative(p.closeTs, now)) +
            "</span></td>" +
            '<td class="mono">' +
            esc(p.symbol) +
            "</td>" +
            '<td class="mono">' +
            esc(p.venue) +
            "</td>" +
            '<td><span class="tag">' +
            esc(reason) +
            "</span></td>" +
            '<td class="right num nowrap">' +
            esc(fmtDuration(held)) +
            "</td>" +
            '<td class="right num ' +
            signClass(p.realizedPnlUsdt) +
            '">' +
            fmtSigned(p.realizedPnlUsdt, 4) +
            "</td>" +
            '<td class="right num ' +
            signClass(p.predictedNetAnnualPct) +
            '">' +
            fmtPct(p.predictedNetAnnualPct, 2) +
            "</td>" +
            '<td class="right num ' +
            signClass(p.realizedAnnualPct) +
            '">' +
            (isNum(p.realizedAnnualPct) ? fmtPct(p.realizedAnnualPct, 2) : "—") +
            "</td>" +
            '<td class="right num ' +
            signClass(error) +
            '">' +
            (isNum(error) ? fmtPct(error, 2) : "—") +
            "</td>" +
            "</tr>"
          );
        })
        .join("");
    }

    note.textContent =
      (settings.enabled === false ? "off · " : "") +
      (isNum(summary.openCount) ? summary.openCount : open.length) +
      "/" +
      (isNum(settings.maxPositions) ? settings.maxPositions : "—") +
      " open · " +
      fmtNum(summary.openNotionalUsdt, 0) +
      " USDT · accrued " +
      fmtSigned(summary.accruedUsdt, 4) +
      " · realised " +
      fmtSigned(summary.realizedPnlUsdt, 4) +
      " · error " +
      (isNum(summary.avgPredictionErrorPct)
        ? fmtPct(summary.avgPredictionErrorPct, 2)
        : "n/a");
    note.classList.remove("bad");
  }

  function carryUnavailable(reason) {
    placeholder($("carry-open-body"), CARRY_OPEN_COLS, "unavailable — " + reason, false);
    placeholder($("carry-closed-body"), CARRY_CLOSED_COLS, "unavailable — " + reason, false);
    $("carry-note").textContent = "unavailable";
    $("carry-note").classList.add("bad");
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
    fee_rate: "set-fee-rate",
    perp_fee_rate: "set-perp-fee-rate",
    india_mode: "set-india-mode",
    tds_rate: "set-tds-rate",
    tax_rate: "set-tax-rate",
    xchg_min_profit_pct: "set-xchg-min-profit",
    xchg_enabled: "set-xchg-enabled",
    funding_min_annual_pct: "set-funding-min",
    funding_hold_days: "set-funding-hold",
    funding_positions_enabled: "set-positions-enabled",
    funding_position_size_usdt: "set-position-size",
    funding_max_positions: "set-max-positions",
    funding_exit_annual_pct: "set-exit-annual",
  };

  function applySettings(s) {
    for (const [key, id] of Object.entries(SETTING_INPUTS)) {
      const input = $(id);
      // Never stomp on a field the operator is mid-edit.
      if (document.activeElement === input) continue;
      // `india_mode` is a 0/1 number on the wire and a checkbox in the DOM;
      // everything else is a plain number in both.
      if (input.type === "checkbox") {
        input.checked = isNum(s[key]) ? s[key] !== 0 : false;
      } else {
        input.value = isNum(s[key]) ? String(s[key]) : "";
      }
    }
    $("settings-summary").textContent =
      "fee " +
      s.fee_rate +
      "/" +
      s.perp_fee_rate +
      (s.xchg_enabled ? " · x-chg min " + s.xchg_min_profit_pct + "%" : " · x-chg off") +
      " · carry min " +
      s.funding_min_annual_pct +
      "%/" +
      s.funding_hold_days +
      "d" +
      (s.funding_positions_enabled
        ? " · pos " +
          s.funding_max_positions +
          "x" +
          s.funding_position_size_usdt +
          " exit " +
          s.funding_exit_annual_pct +
          "%"
        : " · pos off") +
      (s.india_mode ? " · india " + s.tds_rate + "/" + s.tax_rate : "");
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
    // A checkbox has no meaningful `.value`; the API wants the 0/1 the settings
    // table stores, so the translation happens here rather than server-side.
    const isCheck = input.type === "checkbox";
    const value = isCheck ? (input.checked ? 1 : 0) : Number(input.value);
    if (!isCheck && (input.value.trim() === "" || !Number.isFinite(value))) {
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
      // Toggling the mode changes what the portfolio panel and the trades table
      // are supposed to show, and that state only arrives with a fresh poll.
      if (key === "india_mode") refresh();
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
        // The spread half has its own count, its own best and its own failure
        // mode, none of which can fail the scan.
        const bestSpread = isNum(r.bestSpreadNetPct) ? fmtPct(r.bestSpreadNetPct) : "n/a";
        const spreads = r.xchgError
          ? "spreads unavailable (" + r.xchgError + ")"
          : (r.spreadsCount || 0) + " spreads · best " + bestSpread;
        // The funding half is polled on its own cadence, so it reports either a
        // fresh board, a deliberate skip, or its own upstream failure.
        // A venue that failed while others served is a *degraded* board, not a
        // failed poll, so it is appended to the count rather than replacing it.
        const degraded =
          Array.isArray(r.fundingVenueErrors) && r.fundingVenueErrors.length > 0
            ? " (down: " + r.fundingVenueErrors.join(", ") + ")"
            : "";
        const venues = Array.isArray(r.fundingVenues) && r.fundingVenues.length > 0
          ? r.fundingVenues.join("+") + " · "
          : "";
        const funding = r.fundingError
          ? " · funding unavailable (" + r.fundingError + ")"
          : r.fundingSkipped
            ? " · funding not due"
            : " · " +
              venues +
              (r.fundingCount || 0) +
              " perps · best carry " +
              (isNum(r.bestFundingNetAnnualPct)
                ? fmtPct(r.bestFundingNetAnnualPct, 2)
                : "n/a") +
              degraded;
        // The carry pass runs after the board has landed and fails on its own,
        // so it is reported on its own — and stays silent when it did nothing.
        const carryMoved =
          r.positionsOpened || r.positionsClosed || r.carryAccruedUsdt;
        const carry = r.carryError
          ? " · carry failed (" + r.carryError + ")"
          : carryMoved
            ? " · carry +" +
              (r.positionsOpened || 0) +
              "/-" +
              (r.positionsClosed || 0) +
              " · accrued " +
              fmtSigned(r.carryAccruedUsdt, 4)
            : "";
        toast(
          "Scan " +
            (r.source || "unknown") +
            " · " +
            spreads +
            funding +
            carry +
            " · " +
            r.durationMs +
            "ms",
          "info",
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

  /**
   * Close one open carry position by hand.
   *
   * Confirmed first: a close is the one irreversible thing this dashboard can
   * do to a position — it writes a realised P&L, and the API refuses a second
   * close with a 409 rather than overwriting it.
   */
  async function doClosePosition(btn) {
    const id = btn.getAttribute("data-close-position");
    if (!id) return;
    const ok = window.confirm(
      "Close carry position #" + id + " now?\n\n" +
        "It is booked with reason 'manual' and its realised P&L is final.",
    );
    if (!ok) return;

    btn.disabled = true;
    try {
      await getJson("/api/funding/positions/" + encodeURIComponent(id) + "/close", {
        method: "POST",
      });
      toast("Position #" + id + " closed", "ok");
    } catch (err) {
      toast("Close failed: " + err.message, "error");
    } finally {
      btn.disabled = false;
      refresh();
    }
  }

  async function doReset() {
    const ok = window.confirm(
      "Reset the balance and wipe ALL history (trades, spreads, scans, funding," +
        " carry positions)?\n\n" +
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
      const [portfolio, opps, funding, carry, trades, scans] = await Promise.allSettled([
        getJson("/api/portfolio"),
        getJson("/api/opportunities?limit=" + OPPS_LIMIT),
        getJson("/api/funding"),
        getJson("/api/funding/positions?limit=" + CARRY_LIMIT),
        getJson("/api/trades?limit=" + TRADES_LIMIT),
        getJson("/api/scans?limit=" + SCANS_LIMIT),
      ]);

      if (portfolio.status === "fulfilled") renderPortfolio(portfolio.value);
      else portfolioUnavailable(portfolio.reason.message);

      if (opps.status === "fulfilled") {
        renderOpportunities(opps.value.opportunities || [], opps.value.minProfitPct);
      } else {
        placeholder(
          $("opps-body"),
          OPPS_COLS,
          "unavailable — " + opps.reason.message,
          false,
        );
      }

      // One dead route degrades exactly one panel: the funding board is a
      // separate upstream from the spot venues and fails independently of them.
      if (funding.status === "fulfilled") {
        renderFunding(funding.value || {});
      } else {
        placeholder(
          $("funding-body"),
          FUNDING_COLS,
          "unavailable — " + funding.reason.message,
          false,
        );
        $("funding-note").textContent = "unavailable";
        $("funding-note").classList.add("bad");
      }

      if (carry.status === "fulfilled") {
        renderCarry(carry.value || {});
      } else {
        carryUnavailable(carry.reason.message);
      }

      if (trades.status === "fulfilled") {
        const list = trades.value.trades || [];
        renderTrades(list);
        $("stat-trades").textContent = String(list.length);
        $("stat-trades-unit").textContent =
          list.length >= TRADES_LIMIT ? "booked (newest " + TRADES_LIMIT + ")" : "booked";
      } else {
        placeholder(
          $("trades-body"),
          TRADES_COLS(),
          "unavailable — " + trades.reason.message,
          false,
        );
        $("stat-trades").textContent = "—";
      }

      if (scans.status === "fulfilled") {
        const list = scans.value.scans || [];
        renderScans(list);
        renderStatus(list);
      } else {
        placeholder(
          $("scans-body"),
          SCANS_COLS,
          "unavailable — " + scans.reason.message,
          false,
        );
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

    // Delegated for the same reason the legs toggle is: the body is replaced
    // wholesale on every 5s poll.
    $("carry-open-body").addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-close-position]");
      if (btn) doClosePosition(btn);
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
