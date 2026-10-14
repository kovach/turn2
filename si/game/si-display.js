// Spirit Island display for si-game.t: Board A, the Invader board, and River
// Surges in Sunlight's panel. It renders the game as of the pending choice's
// moment (or the end of the last turn) and turns each pending `you` choice
// into clicks on whatever the options are: lands, pieces, cards, presence
// tracks, or labelled buttons for the rest.
//
// How it reads the game: each player decision in si-game.t is named by an
// `ask <kind> C ...` tuple whose C is the choice's active term, so the kind
// (and its context arguments) tell the display what to ask. State rows are
// the `#acc` rows whose (point) interval contains the chosen moment.

import { intervalContains, tokenOf } from "/src/v2/store.js";

const CSS = `
.si { --si-ink: var(--fg, #ddd); --si-mute: var(--fg-mute, #999); --si-line: var(--border, #444);
      --si-panel: var(--bg-2, #1e1e1e); --si-hi: #f2c14e; --si-river: #2f7fd1; --si-bad: #c4473a;
      font: 13px/1.4 system-ui, sans-serif; color: var(--si-ink); display: flex; flex-direction: column; gap: 10px; padding: 8px; }
.si-prompt { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--si-line);
             border-left: 4px solid var(--si-hi); background: var(--si-panel); border-radius: 4px; }
.si-prompt .q { font-weight: 600; margin-right: 6px; }
.si-prompt .ctx { color: var(--si-mute); }
.si-btn { font: inherit; padding: 3px 10px; border-radius: 4px; border: 1px solid var(--si-hi); background: transparent; color: var(--si-ink); cursor: pointer; }
.si-btn:hover { background: color-mix(in srgb, var(--si-hi) 25%, transparent); }
.si-btn.quiet { border-color: var(--si-line); }
.si-banner { padding: 10px 14px; font-weight: 700; font-size: 15px; border-radius: 4px; }
.si-banner.won { background: #2e7d4f; color: white; } .si-banner.lost { background: var(--si-bad); color: white; }
.si-main { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
.si-board { flex: 1 1 520px; min-width: 320px; max-width: 760px; }
.si-board svg { width: 100%; height: auto; display: block; }
.si-side { flex: 1 1 300px; min-width: 260px; display: flex; flex-direction: column; gap: 10px; }
.si-box { border: 1px solid var(--si-line); border-radius: 4px; background: var(--si-panel); padding: 8px 10px; }
.si-box h4 { margin: 0 0 6px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--si-mute); font-weight: 600; }
.si-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.si-stat { display: inline-flex; flex-direction: column; min-width: 64px; }
.si-stat b { font-size: 18px; font-variant-numeric: tabular-nums; }
.si-stat span { font-size: 11px; color: var(--si-mute); }
.si-icard { border: 1px solid var(--si-line); border-radius: 3px; padding: 4px 6px; min-width: 70px; text-align: center; }
.si-icard small { display: block; color: var(--si-mute); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
.si-card { border: 1px solid var(--si-line); border-radius: 5px; padding: 5px 7px; width: 132px; background: color-mix(in srgb, var(--si-panel) 70%, #000 6%); }
.si-card .nm { font-weight: 600; } .si-card .meta { font-size: 11px; color: var(--si-mute); }
.si-card .tx { font-size: 11px; margin-top: 3px; }
.si-card.fast .meta .sp { color: #e0653a; } .si-card.slow .meta .sp { color: #4d8fd6; }
.si-card.pick, .si-track.pick, .si-slot.pick { outline: 2px solid var(--si-hi); cursor: pointer; }
.si-card.pick:hover { background: color-mix(in srgb, var(--si-hi) 18%, transparent); }
.si-card.dim { opacity: .55; }
.si-track { display: flex; gap: 4px; align-items: center; padding: 3px; border-radius: 4px; }
.si-track .lbl { width: 76px; font-size: 11px; color: var(--si-mute); }
.si-slot { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700;
           border: 1px dashed var(--si-line); }
.si-slot.covered { background: var(--si-river); color: white; border: 2px solid white; }
.si-el { display: inline-block; padding: 0 6px; border-radius: 9px; font-size: 11px; border: 1px solid var(--si-line); }
.si-log { font-size: 11px; color: var(--si-mute); max-height: 120px; overflow: auto; }
.si-land { cursor: default; }
.si-land.pick { cursor: pointer; }
.si-land.pick path { stroke: var(--si-hi); stroke-width: 4; }
.si-land.pick:hover path { filter: brightness(1.15); }
.si-piece { pointer-events: auto; }
.si-piece.pick { cursor: pointer; pointer-events: auto; }
.si-piece.pick .ring { stroke: var(--si-hi); stroke-width: 3; fill: none; }
`;

// ---------------------------------------------------------------- board geometry (Board A)
const V = {
  A: [60, 20], B: [240, 20], C: [400, 20], D: [570, 40], E: [60, 150], G: [260, 110], H: [200, 170],
  I: [410, 130], J: [330, 175], K: [560, 250], L: [450, 240], M: [400, 320], N: [260, 290], S: [160, 250],
  T: [540, 400], U: [320, 400], Vv: [270, 400], W: [170, 400], X: [60, 270], Y: [60, 400],
};
const LANDS = {
  a1: { poly: ["A", "B", "G", "H", "E"], at: [150, 78], num: [80, 42] },
  a2: { poly: ["E", "H", "S", "X"], at: [118, 208], num: [78, 170] },
  a3: { poly: ["X", "S", "W", "Y"], at: [112, 330], num: [78, 290] },
  a4: { poly: ["H", "N", "Vv", "W", "S"], at: [212, 322], num: [182, 268] },
  a5: { poly: ["G", "J", "I", "L", "M", "U", "Vv", "N", "H"], at: [345, 262], num: [292, 204] },
  a6: { poly: ["B", "C", "I", "J", "G"], at: [325, 72], num: [262, 42] },
  a7: { poly: ["L", "K", "T", "U", "M"], at: [470, 338], num: [450, 268] },
  a8: { poly: ["C", "D", "K", "L", "I"], at: [492, 150], num: [430, 48] },
};
const TERRAIN = { mountain: "#9c9a90", wetland: "#7db6c9", jungle: "#5f9b5c", sands: "#d6b877" };

// ---------------------------------------------------------------- card text (SICK catalog)
const CARD_TEXT = {
  "flash-floods": "1 Damage. If target land is Coastal, +1 Damage.",
  "wash-away": "Push up to 3 Explorer / Town.",
  "boon-of-vigor": "If you target yourself, gain 1 Energy.",
  "rivers-bounty": "Gather up to 2 Dahan. If there are now at least 2 Dahan, add 1 Dahan and gain 1 Energy.",
  "uncanny-melting": "If Invaders are present, 1 Fear. If target land is Sands / Wetland, remove 1 Blight.",
  "rain-of-blood": "2 Fear. If target land has at least 2 Town / City, +1 Fear.",
  "encompassing-ward": "Target Spirit provides Defend 2 in each of its lands.",
  "devouring-ants": "1 Fear. 1 Damage. Destroy 1 Dahan. If target land is Jungle / Sands, +1 Damage.",
  "massive-flooding": "Innate. 1 Sun 2 Water: Push 1 Explorer / Town. 2 Sun 3 Water: instead 2 Damage, Push up to 3.",
};
const FEAR_TEXT = {
  "avoid-the-dahan": "Invaders do not Explore into lands with at least 2 Dahan.",
  "avoid-the-dahan-2": "Invaders do not Explore into lands with at least 2 Dahan.",
  "wary-of-the-interior": "Each player removes 1 Explorer from an Inland land.",
  "emigration-accelerates": "Each player removes 1 Explorer from a Coastal land.",
  "dahan-on-their-guard": "In each land, Defend 1 per Dahan.",
};
const GROWTH = {
  "reclaim-card-energy": "Reclaim Cards · Gain Power Card · +1 Energy",
  "two-presence": "Add Presence (range 1) · Add Presence (range 1)",
  "card-presence": "Gain Power Card · Add Presence (range 2)",
};
const nice = (s) => String(s).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ 2$/, "");
const SVGNS = "http://www.w3.org/2000/svg";

export function create(api) {
  const { peek, addStyles, tokensEq, commit, kit } = api;
  // Display-kit entities (plans/v2-display-kit.md): each visible thing is
  // declared with the store rows it is drawn from, for its tooltip and its
  // right-click menu into the rules behind it. Every row array read below
  // carries its tuple index as `.idx`.
  const entity = (e, spec) => kit?.entity(e, spec);
  // Tuple indices from any mix of indices, rows (arrays with `.idx`) and
  // lists of those.
  const ids = (...rs) => {
    const out = [];
    const walk = (r) => {
      if (r == null) return;
      if (typeof r === "number") out.push(r);
      else if (r.idx != null) out.push(r.idx);
      else if (Array.isArray(r)) r.forEach(walk);
    };
    rs.forEach(walk);
    return out;
  };
  addStyles(CSS);
  let store_ = null; // the store being rendered (for peek in helpers)


  // ---------------------------------------------------------------- reading the store
  function name(t) {
    if (!t) return null;
    if (t.tag === "Symbol") return t.name;
    return null;
  }
  function parts(t) {
    const a = peek(t, store_);
    return a ? a.terms : null;
  }
  function momentToShow(store, comp) {
    if (comp) return comp.moment;
    // nothing pending: the start of the window after the last finished turn
    let best = null, bestN = -1;
    for (const idx of store.byHead.get("turn-ended") ?? []) {
      const t = store.tuples[idx];
      const n = Number(name(t.atom.terms[1]));
      if (n > bestN) { bestN = n; best = t.l; }
    }
    return best ?? store.top;
  }

  function rowsAt(store, head, M) {
    const out = [];
    for (const idx of store.byHead.get(head) ?? []) {
      const t = store.tuples[idx];
      if (!intervalContains(store, t.l, t.r, M, M)) continue;
      const row = t.atom.terms.slice(1, -1);
      row.idx = idx;
      out.push(row);
    }
    return out;
  }
  function rowsAll(store, head) {
    return (store.byHead.get(head) ?? []).map((idx) => {
      const row = store.tuples[idx].atom.terms.slice(1, -1);
      row.idx = idx;
      return row;
    });
  }
  const num = (t) => Number(name(t));

  function readState(store, M) {
    store_ = store;
    const key = (t) => tokenOf(store, t);
    const st = { M, pieces: new Map(), lands: new Map(), cards: new Map() };
    // static facts
    for (const r of rowsAll(store, "land:terrain")) st.lands.set(name(r[0]), { terrain: name(r[1]), coastal: false, pieces: [], rows: [r.idx] });
    if (st.lands.size === 0) return null;
    for (const r of rowsAll(store, "coastal")) { const L = st.lands.get(name(r[0])); if (L) { L.coastal = true; L.rows.push(r.idx); } }
    const kindOf = new Map(), kindRow = new Map();
    for (const r of rowsAll(store, "piece:kind")) { kindOf.set(key(r[0]), name(r[1])); kindRow.set(key(r[0]), r.idx); }
    const presenceOwner = new Map(), ownerRow = new Map();
    for (const r of rowsAll(store, "presence-of")) { presenceOwner.set(key(r[1]), name(r[0])); ownerRow.set(key(r[1]), r.idx); }
    for (const r of rowsAll(store, "card")) st.cards.set(name(r[0]), { name: name(r[0]), elements: [], rows: [r.idx] });
    for (const r of rowsAll(store, "innate")) st.cards.set(name(r[0]), { name: name(r[0]), elements: [], innate: true, rows: [r.idx] });
    for (const r of rowsAll(store, "power:cost")) { const C = st.cards.get(name(r[0])); if (C) { C.cost = num(r[1]); C.rows.push(r.idx); } }
    for (const r of rowsAll(store, "power:speed")) { const C = st.cards.get(name(r[0])); if (C) { C.speed = name(r[1]); C.rows.push(r.idx); } }
    for (const r of rowsAll(store, "power:element")) { const C = st.cards.get(name(r[0])); if (C) { C.elements.push(name(r[1])); C.rows.push(r.idx); } }
    // locations at M
    st.slots = [];
    st.cardLoc = new Map();
    st.cardLocRow = new Map();
    for (const atRow of rowsAt(store, "at", M)) {
      const [it, loc] = atRow;
      const k = key(it);
      const locName = name(loc);
      if (locName && st.lands.has(locName)) {
        const kind = kindOf.get(k) ?? "?";
        const piece = { term: it, key: k, kind, land: locName, damage: 0, rows: ids(atRow, kindRow.get(k), ownerRow.get(k)) };
        st.pieces.set(k, piece);
        st.lands.get(locName).pieces.push(piece);
        continue;
      }
      const ps = loc ? parts(loc) : null;
      if (ps && name(ps[0]) === "slot") { st.slots.push({ track: name(ps[2]), index: num(ps[3]), row: atRow.idx }); continue; }
      if (name(it) !== null) st.cardLocRow.set(name(it), atRow.idx);
      if (ps && name(ps[0]) === "hand") st.cardLoc.set(name(it), "hand");
      else if (ps && name(ps[0]) === "played") st.cardLoc.set(name(it), "played");
      else if (ps && name(ps[0]) === "discard") st.cardLoc.set(name(it), "discard");
      else if (locName === "minor-deck" || locName === "minor-discard") st.cardLoc.set(name(it), locName);
    }
    for (const r of rowsAt(store, "damage", M)) { const P = st.pieces.get(key(r[0])); if (P) { P.damage = num(r[1]); P.rows.push(r.idx); } }
    st.presenceOwner = presenceOwner;
    // spirit, invaders, fear, blight
    // `st.rows[name]`: the rows behind each stat, for its entity
    st.rows = {};
    const one = (head) => { const r = rowsAt(store, head, M)[0]; st.rows[head] = ids(r); return r ? r : null; };
    st.energy = num(one("energy")?.[1] ?? { tag: "Symbol", name: "0" });
    st.income = {};
    st.rows.income = {};
    for (const r of rowsAt(store, "income", M)) { st.income[name(r[1])] = num(r[2]); st.rows.income[name(r[1])] = [r.idx]; }
    st.elements = {};
    st.rows.elements = [];
    for (const r of rowsAt(store, "elements", M)) { st.elements[name(r[1])] = num(r[2]); st.rows.elements.push(r.idx); }
    st.slotValues = { energy: [], cards: [] };
    st.slotRows = { energy: [], cards: [] };
    for (const r of rowsAll(store, "slot-value")) { (st.slotValues[name(r[0])] ??= [])[num(r[1])] = num(r[2]); (st.slotRows[name(r[0])] ??= [])[num(r[1])] = r.idx; }
    st.turn = num(one("now")?.[0] ?? { tag: "Symbol", name: "0" });
    st.invaderCards = {};
    st.rows.invaderCards = {};
    for (const r of rowsAt(store, "card-at", M)) if (num(r[0]) === st.turn) { st.invaderCards[name(r[1])] = name(r[2]); st.rows.invaderCards[name(r[1])] = [r.idx]; }
    st.cardTerrain = {};
    st.cardTerrainRows = {};
    for (const r of rowsAll(store, "card:terrain")) { (st.cardTerrain[name(r[0])] ??= []).push(name(r[1])); (st.cardTerrainRows[name(r[0])] ??= []).push(r.idx); }
    for (const r of rowsAll(store, "card:coastal")) { st.cardTerrain[name(r[0])] = ["coastal"]; st.cardTerrainRows[name(r[0])] = [r.idx]; }
    st.fear = num(one("fear-generated")?.[0] ?? { tag: "Symbol", name: "0" });
    st.fearEarned = num(one("fear-cards-earned")?.[0] ?? { tag: "Symbol", name: "0" });
    st.fearResolved = [];
    st.rows.fearResolved = [];
    for (const idx of store.byHead.get("fear-resolved") ?? []) {
      const t = store.tuples[idx];
      if (lessOrEq(store, t.l, M)) { st.fearResolved.push(name(t.atom.terms[1])); st.rows.fearResolved.push(idx); }
    }
    st.blightCard = num(one("blight-on-card")?.[0] ?? { tag: "Symbol", name: "3" });
    ({ label: st.phase, idx: st.rows.phase } = phaseAt(store, M));
    st.defend = {};
    for (const r of rowsAt(store, "defend-total", M)) if (num(r[1]) > 0) { st.defend[name(r[0])] = num(r[1]); st.lands.get(name(r[0]))?.rows.push(r.idx); }
    st.blightedIsland = (store.byHead.get("blighted-island") ?? []).some((idx) => lessOrEq(store, store.tuples[idx].l, M));
    for (const [w] of rowsAll(store, "lost")) st.lost = name(w);
    for (const [w] of rowsAll(store, "won")) st.won = name(w);
    st.played = new Set();
    for (const idx of store.byHead.get("played") ?? []) {
      const t = store.tuples[idx];
      if (num(t.atom.terms[3]) === st.turn) st.played.add(name(t.atom.terms[2]));
    }
    return st;
  }

  function lessOrEq(store, a, b) {
    return intervalContains(store, a, store.top, b, b);
  }

  function phaseAt(store, M) {
    const phases = [["spirit-phase", "Spirit Phase"], ["fast-phase", "Fast Powers"], ["invader-phase", "Invader Phase"],
      ["slow-phase", "Slow Powers"], ["time-passes", "Time Passes"], ["setup", "Setup"]];
    for (const [h, label] of phases) {
      for (const idx of store.byHead.get(h) ?? []) {
        const t = store.tuples[idx];
        if (intervalContains(store, t.l, t.r, M, M)) return { label, idx };
      }
    }
    return { label: "", idx: null };
  }

  function findAsk(store, comp) {
    for (const idx of store.byHead.get("ask") ?? []) {
      const ts = store.tuples[idx].atom.terms;
      if (comp.activeTerms.some((a) => tokensEq(a, ts[2], store))) {
        return { kind: name(ts[1]), args: ts.slice(3, -1) };
      }
    }
    return null;
  }

  // classify each option of the (single-term) component
  function optionsOf(store, comp, st) {
    const lands = new Map(), pieces = new Map(), cards = new Map(), tracks = new Map(), other = [];
    comp.options.forEach((tuple) => {
      const v = tuple[0];
      const intent = { activeTerms: comp.activeTerms, optionTuple: tuple };
      const n = name(v);
      if (n && st.lands.has(n)) lands.set(n, intent);
      else if (n && st.cards.has(n)) cards.set(n, intent);
      else if (n === "energy" || n === "cards") tracks.set(n, intent);
      else if (st.pieces.has(tokenOf(store, v))) pieces.set(tokenOf(store, v), intent);
      else other.push({ label: n ?? api.renderTerm(store, v), intent });
    });
    return { lands, pieces, cards, tracks, other };
  }

  // ---------------------------------------------------------------- prompt
  function renderPrompt(store, st, comp, ask, opts) {
    const bar = el("div", "si-prompt");
    const turnTxt = st.turn ? `Turn ${st.turn}` : "Setup";
    const ctxEl = el("span", "ctx", `${turnTxt} · ${st.phase || "—"}`);
    entity(ctxEl, { label: `${turnTxt}, ${st.phase || "no phase"}`, rows: ids(st.rows.now, st.rows.phase) });
    bar.append(ctxEl);
    if (!comp) {
      bar.append(el("span", "q", st.lost || st.won ? "Game over." : "Nothing to decide."));
      return bar;
    }
    const [q, hint] = question(store, st, ask, opts);
    bar.append(el("span", "q", q));
    if (hint) bar.append(el("span", "ctx", hint));
    for (const o of opts.other) {
      const label = GROWTH[o.label] ?? (o.label === "done" ? "Done" : nice(o.label));
      const b = el("button", "si-btn" + (o.label === "done" ? " quiet" : ""), label);
      b.addEventListener("click", () => commit(o.intent));
      bar.append(b);
    }
    // options with no visual home get a button too
    if (ask && (ask.kind === "growth")) return bar;
    return bar;
  }

  function question(store, st, ask, opts) {
    if (!ask) return ["Choose:", ""];
    const a = (i) => ask.args[i];
    const land = (t) => (name(t) ?? "").replace("a", "land ");
    switch (ask.kind) {
      case "growth": return ["Growth: pick one.", ""];
      case "track": return ["Add a Presence: take it from which track?", "click a track on the Spirit panel"];
      case "place": return ["Add a Presence: choose a land.", "highlighted lands are in range"];
      case "play": return [`Play Power Cards.`, `Energy ${st.energy}, plays ${st.played.size}/${st.income.cards ?? 1}. Click a card, or Done.`];
      case "resolve": return [`${name(a(2)) === "fast" ? "Fast" : "Slow"} Powers: use which?`, "click a played card (or the innate), or Done to skip the rest"];
      case "target": return [`Target a land for ${nice(name(a(1)))}.`, ""];
      case "damage": return [`Damage in ${land(a(0))}: pick an Invader.`, `${num(a(1))} Damage left`];
      case "push": return [`Push from ${land(a(0))}: pick a piece, or Done.`, `up to ${num(a(1))} more`];
      case "push-to": return [`Push to which land?`, `from ${land(a(1))}`];
      case "gather": return [`Gather into ${land(a(0))}: pick a piece, or Done.`, `up to ${num(a(1))} more`];
      case "cascade": return [`Blight cascades from ${land(a(0))}: choose an adjacent land.`, ""];
      case "fear-remove": return [`Fear: ${nice(name(a(0)))}.`, "pick an Explorer to remove"];
      case "gain-card": return ["Gain a Power Card: keep one.", "the other is discarded"];
      default: return [`${ask.kind}:`, ""];
    }
  }

  // ---------------------------------------------------------------- board
  function renderBoard(store, st, opts, comp) {
    const wrap = el("div", "si-board");
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 620 430");
    const ocean = svgEl("path", { d: "M0 0 H64 Q50 70 66 140 Q52 210 64 280 Q50 350 66 430 H0 Z", fill: "#3b6f9f" });
    svg.append(ocean);
    const oceanTxt = svgEl("text", { x: 20, y: 220, fill: "white", "font-size": 13, transform: "rotate(-90 20 220)", "text-anchor": "middle" });
    oceanTxt.textContent = "OCEAN";
    svg.append(oceanTxt);
    for (const [id, geo] of Object.entries(LANDS)) {
      const L = st.lands.get(id);
      if (!L) continue;
      const g = svgEl("g", { class: "si-land" });
      const d = "M" + geo.poly.map((v) => V[v].join(" ")).join(" L") + " Z";
      g.append(svgEl("path", { d, fill: TERRAIN[L.terrain] ?? "#888", stroke: "#2b2b2b", "stroke-width": 2, "stroke-linejoin": "round" }));
      const t = svgEl("text", { x: geo.num[0], y: geo.num[1], "font-size": 15, "font-weight": 700, fill: "#1d1d1d" });
      t.textContent = id.slice(1);
      g.append(t);
      const tt = svgEl("text", { x: geo.num[0] + 14, y: geo.num[1], "font-size": 10, fill: "#1d1d1d", opacity: 0.75 });
      tt.textContent = L.terrain + (st.defend[id] ? `  · Defend ${st.defend[id]}` : "");
      g.append(tt);
      const intent = opts?.lands.get(id);
      if (intent) {
        g.classList.add("pick");
        g.addEventListener("click", () => commit(intent));
      }
      entity(g, {
        label: `Land ${id.slice(1)}: ${nice(L.terrain)}${L.coastal ? ", coastal" : ""}`,
        notes: st.defend[id] ? [`Defend ${st.defend[id]}`] : [],
        rows: L.rows,
        choice: intent,
      });
      svg.append(g);
    }
    // pieces, laid out in a grid around each land's anchor
    for (const [id, geo] of Object.entries(LANDS)) {
      const L = st.lands.get(id);
      if (!L) continue;
      const order = ["city", "town", "explorer", "dahan", "presence", "blight", "disease", "beasts"];
      const ps = [...L.pieces].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
      const cols = 4, step = 24;
      ps.forEach((p, i) => {
        const x = geo.at[0] + ((i % cols) - (Math.min(ps.length, cols) - 1) / 2) * step;
        const y = geo.at[1] + (Math.floor(i / cols) - (Math.ceil(ps.length / cols) - 1) / 2) * step;
        const g = pieceGlyph(p, x, y);
        const intent = opts?.pieces.get(p.key);
        const landIntent = opts?.lands.get(id);
        if (intent) {
          g.classList.add("pick");
          g.addEventListener("click", (ev) => { ev.stopPropagation(); commit(intent); });
        } else if (landIntent) {
          // Pieces take the pointer (for their tooltips); a click on one that
          // isn't a choice picks its land.
          g.style.cursor = "pointer";
          g.addEventListener("click", () => commit(landIntent));
        }
        entity(g, {
          label: `${nice(p.kind)} in land ${id.slice(1)}` + (p.damage ? ` (${p.damage} Damage)` : ""),
          rows: p.rows,
          choice: intent,
        });
        svg.append(g);
      });
    }
    wrap.append(svg);
    return wrap;
  }

  function pieceGlyph(p, x, y) {
    const g = svgEl("g", { class: "si-piece", transform: `translate(${x} ${y})` });
    const ink = "#202020", bone = "#f3ecd8";
    switch (p.kind) {
      case "explorer":
        g.append(svgEl("circle", { cx: 0, cy: -6, r: 4, fill: bone, stroke: ink, "stroke-width": 1.2 }));
        g.append(svgEl("path", { d: "M-6 9 L0 -2 L6 9 Z", fill: bone, stroke: ink, "stroke-width": 1.2 }));
        break;
      case "town":
        g.append(svgEl("path", { d: "M-8 9 V-1 L0 -8 L8 -1 V9 Z", fill: bone, stroke: ink, "stroke-width": 1.4 }));
        break;
      case "city":
        g.append(svgEl("path", { d: "M-10 9 V-4 L-5 -9 L0 -4 V-7 L5 -11 L10 -7 V9 Z", fill: bone, stroke: ink, "stroke-width": 1.4 }));
        break;
      case "dahan":
        g.append(svgEl("ellipse", { cx: 0, cy: 2, rx: 8, ry: 7, fill: "#c9a46b", stroke: "#5b4120", "stroke-width": 1.4 }));
        g.append(svgEl("ellipse", { cx: 0, cy: -2, rx: 8, ry: 3, fill: "#dcbc87", stroke: "#5b4120", "stroke-width": 1 }));
        break;
      case "presence":
        g.append(svgEl("circle", { cx: 0, cy: 0, r: 9, fill: "#2f7fd1", stroke: "white", "stroke-width": 2.5 }));
        break;
      case "blight":
        g.append(svgEl("path", { d: "M-9 7 Q-10 -6 -2 -9 Q8 -10 9 -1 Q10 8 2 9 Q-5 10 -9 7 Z", fill: "#151515", stroke: "#444", "stroke-width": 1 }));
        g.append(svgEl("circle", { cx: 0, cy: 0, r: 3, fill: "none", stroke: "#888", "stroke-width": 1 }));
        break;
      case "disease":
        g.append(svgEl("circle", { cx: 0, cy: 0, r: 9, fill: "#b9c46a", stroke: "#4c5422", "stroke-width": 1.4 }));
        g.append(textAt("D", 0, 4, 10, "#2f3514"));
        break;
      case "beasts":
        g.append(svgEl("circle", { cx: 0, cy: 0, r: 9, fill: "#a9512f", stroke: "#4a2010", "stroke-width": 1.4 }));
        g.append(textAt("B", 0, 4, 10, "white"));
        break;
      default:
        g.append(svgEl("circle", { cx: 0, cy: 0, r: 6, fill: "#999" }));
    }
    if (p.damage) {
      g.append(svgEl("circle", { cx: 9, cy: -9, r: 6, fill: "#c4473a" }));
      g.append(textAt(String(p.damage), 9, -6, 9, "white"));
    }
    g.append(svgEl("circle", { class: "ring", cx: 0, cy: 0, r: 13, fill: "none", stroke: "none" }));
    return g;
  }

  // ---------------------------------------------------------------- side panels
  function renderSide(store, st, opts, comp, ask) {
    const side = el("div", "si-side");

    const inv = box("Invader Board");
    const row = el("div", "si-row");
    for (const step of ["ravage", "build", "explore"]) {
      const c = st.invaderCards[step];
      const card = el("div", "si-icard");
      card.append(el("small", "", step));
      card.append(document.createTextNode(c ? (st.cardTerrain[c] ?? []).map(nice).join(" + ") : "—"));
      entity(card, {
        label: c ? `${nice(step)}: ${nice(c)}` : `${nice(step)}: no card`,
        rows: ids(st.rows.invaderCards[step], c ? st.cardTerrainRows[c] : []),
      });
      row.append(card);
    }
    inv.append(row);
    const stats = el("div", "si-row");
    stats.style.marginTop = "6px";
    stats.append(stat(4 - (st.fear % 4), "fear pool", st.rows["fear-generated"]),
      stat(st.fearEarned - st.fearResolved.length, "fear cards waiting", ids(st.rows["fear-cards-earned"], st.rows.fearResolved)),
      stat(st.blightCard, st.blightedIsland ? "blight (Blighted Island)" : "blight on card", st.rows["blight-on-card"]), stat(1, "terror level"));
    inv.append(stats);
    if (st.fearResolved.length) {
      const fr = el("div", "si-log");
      fr.textContent = "Fear resolved: " + st.fearResolved.map((f) => `${nice(f)} (${FEAR_TEXT[f] ?? ""})`).join("; ");
      entity(fr, { label: "Fear cards resolved", rows: st.rows.fearResolved });
      inv.append(fr);
    }
    side.append(inv);

    const sp = box("River Surges in Sunlight");
    const s1 = el("div", "si-row");
    s1.append(stat(st.energy, "energy", st.rows.energy), stat(st.income.energy ?? 1, "energy / turn", st.rows.income.energy),
      stat(st.income.cards ?? 1, "card plays", st.rows.income.cards));
    sp.append(s1);
    const els = el("div", "si-row");
    els.style.margin = "6px 0";
    const elNames = Object.entries(st.elements).filter(([, n]) => n > 0);
    els.append(el("span", "ctx", elNames.length ? "Elements:" : "No Elements this turn"));
    for (const [e, n] of elNames) els.append(el("span", "si-el", `${n} ${nice(e)}`));
    entity(els, { label: "Elements this turn", rows: st.rows.elements });
    sp.append(els);
    for (const track of ["energy", "cards"]) sp.append(trackRow(st, track, opts));
    const special = el("div", "si-log");
    special.textContent = "River's Domain: your Presence in Wetlands counts as a Sacred Site.";
    sp.append(special);
    side.append(sp);

    const groups = [["hand", "Hand"], ["played", "In play"], ["discard", "Discard"]];
    for (const [loc, label] of groups) {
      const cs = [...st.cardLoc].filter(([, l]) => l === loc).map(([c]) => c);
      if (!cs.length && loc !== "hand") continue;
      const b = box(label);
      const r = el("div", "si-row");
      for (const c of cs) r.append(cardEl(st, c, opts));
      if (!cs.length) r.append(el("span", "ctx", "(empty)"));
      b.append(r);
      side.append(b);
    }
    // cards offered from the Minor deck, and the innate
    const extra = [...(opts?.cards.keys() ?? [])].filter((c) => !["hand", "played", "discard"].includes(st.cardLoc.get(c)));
    if (extra.length) {
      const b = box(ask?.kind === "gain-card" ? "Minor Powers drawn" : "Innate Power");
      const r = el("div", "si-row");
      for (const c of extra) r.append(cardEl(st, c, opts));
      b.append(r);
      side.append(b);
    }
    return side;
  }

  function trackRow(st, track, opts) {
    const r = el("div", "si-track");
    r.append(el("span", "lbl", track === "energy" ? "Energy / turn" : "Card plays"));
    const covered = new Set(st.slots.filter((s) => s.track === track).map((s) => s.index));
    const vals = st.slotValues[track] ?? [];
    for (let i = 0; i < vals.length; i++) {
      const s = el("div", "si-slot" + (i > 0 && covered.has(i) ? " covered" : ""), i > 0 && covered.has(i) ? "" : String(vals[i]));
      const presence = st.slots.find((sl) => sl.track === track && sl.index === i);
      entity(s, {
        label: `${track === "energy" ? "Energy" : "Card plays"} track, slot ${i}: ` +
          (i > 0 && covered.has(i) ? `covered by Presence (${vals[i]} when uncovered)` : `uncovered, ${vals[i]}`),
        rows: ids(st.slotRows[track]?.[i], presence?.row),
      });
      r.append(s);
    }
    const intent = opts?.tracks.get(track);
    if (intent) {
      r.classList.add("pick");
      r.title = "take the next Presence from this track";
      r.addEventListener("click", () => commit(intent));
      entity(r.querySelector(".lbl"), { label: "Take the next Presence from this track", choice: intent });
    }
    return r;
  }

  function cardEl(st, c, opts) {
    const info = st.cards.get(c) ?? { elements: [] };
    const isInnate = c === "massive-flooding";
    const speed = info.speed ?? (isInnate ? "slow" : "");
    const d = el("div", `si-card ${speed}`);
    d.append(el("div", "nm", nice(c)));
    const meta = el("div", "meta");
    meta.append(el("span", "", isInnate ? "innate · " : `${info.cost ?? 0} energy · `), el("span", "sp", speed));
    if (info.elements.length) meta.append(document.createTextNode(" · " + info.elements.map(nice).join(", ")));
    d.append(meta);
    d.append(el("div", "tx", CARD_TEXT[c] ?? ""));
    const intent = opts?.cards.get(c);
    if (intent) {
      d.classList.add("pick");
      d.addEventListener("click", () => commit(intent));
    } else if (opts && opts.cards.size) {
      d.classList.add("dim");
    }
    const where = st.cardLoc.get(c);
    entity(d, {
      label: `${nice(c)}${where ? ` (${where})` : ""}`,
      notes: CARD_TEXT[c] ? [CARD_TEXT[c]] : [],
      rows: ids(info.rows ?? [], st.cardLocRow.get(c)),
      choice: intent,
    });
    return d;
  }

  // ---------------------------------------------------------------- small helpers
  function lossText(w) {
    return { blight: "the Blight card ran out", time: "the Invader Deck ran out", presence: "your Presence was destroyed" }[w] ?? w;
  }
  function box(title) { const b = el("div", "si-box"); b.append(el("h4", "", title)); return b; }
  function stat(v, label, rows) {
    const s = el("div", "si-stat");
    s.append(el("b", "", String(v)), el("span", "", label));
    if (rows !== undefined) entity(s, { label: `${v} ${label}`, rows: ids(rows) });
    return s;
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function svgEl(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; }
  function textAt(s, x, y, size, fill) { const t = svgEl("text", { x, y, "font-size": size, fill, "text-anchor": "middle", "font-weight": 700 }); t.textContent = s; return t; }

  return {
    render(store, ctx) {
      const comp = ctx.components[ctx.selectedIdx] ?? null;
      const M = momentToShow(store, comp);
      const st = readState(store, M);
      if (!st) return null;
      const ask = comp ? findAsk(store, comp) : null;
      const opts = comp ? optionsOf(store, comp, st) : null;

      const root = el("div", "si");
      if (st.lost) root.append(el("div", "si-banner lost", `Defeat: ${lossText(st.lost)}`));
      if (st.won) root.append(el("div", "si-banner won", `Victory: ${st.won === "fear" ? "the Invaders flee in terror" : "no Invaders remain"}`));
      root.append(renderPrompt(store, st, comp, ask, opts));
      const main = el("div", "si-main");
      main.append(renderBoard(store, st, opts, comp), renderSide(store, st, opts, comp, ask));
      root.append(main);
      return { element: root, clicks: new Map() };
    },
  };
}
