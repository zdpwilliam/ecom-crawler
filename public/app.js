"use strict";
(() => {
  // src/ui/app.ts
  var $ = (s) => document.querySelector(s);
  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
        else if (j && j.reason) msg = j.reason;
      } catch {
      }
      if (res.status === 404 && !msg.includes("VPN")) {
        msg += " \u2014\u2014 \u63A5\u53E3\u4E0D\u5B58\u5728\u3002\u82E5\u53CD\u590D\u51FA\u73B0\uFF1A\u53EF\u80FD\u662F VPN/\u7CFB\u7EDF\u4EE3\u7406\u62E6\u622A\u4E86 localhost \u8BF7\u6C42\uFF0C\u8BF7\u6539\u7528 http://127.0.0.1:4311 \u8BBF\u95EE\uFF0C\u6216\u5728 VPN \u91CC\u628A localhost/127.0.0.1 \u52A0\u5165\u76F4\u8FDE\u767D\u540D\u5355\u540E\u6309 Ctrl+F5 \u5237\u65B0\u9875\u9762\u3002";
      }
      throw new Error(msg);
    }
    return res;
  }
  async function apiJson(path, opts = {}) {
    return api(path, opts).then((r) => r.json());
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  }
  var currentType = "product";
  var PAGES = ["collect", "data", "jobs", "settings"];
  function showPage(name) {
    if (!PAGES.includes(name)) name = "collect";
    document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${name}`));
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.page === name));
    if (location.hash !== `#/${name}`) history.replaceState(null, "", `#/${name}`);
    if (name === "data") renderTable(currentType, true);
    if (name === "jobs") {
      loadJobs();
      loadRuns();
    }
    if (name === "settings") loadLoginStatus();
  }
  var PLATFORM_META = {
    vip: { direct: "rank/list \u76F4\u8FDE + \u8BE6\u60C5\u63A5\u53E3\uFF08\u9700\u767B\u5F55\u6001\uFF09", login: "\u5FC5\u9700" },
    huawei: { direct: "\u641C\u7D22+\u8BE6\u60C5 \u5168\u94FE\u8DEF\u76F4\u8FDE\uFF08\u533F\u540D\uFF09", login: "\u4E0D\u9700\u8981" },
    suning: { direct: "\u641C\u7D22 SSR + \u6279\u91CF\u4EF7\u683C + \u8BE6\u60C5\u76F4\u8FDE", login: "\u4E0D\u9700\u8981" },
    amazon: { direct: "\u641C\u7D22+\u8BE6\u60C5 \u5168\u76F4\u8FDE\uFF08SSR \u89E3\u6790\uFF09", login: "\u4E0D\u9700\u8981" },
    taobao: { direct: "mtop \u7B7E\u540D\u76F4\u8FDE", login: "\u5FC5\u9700" },
    xianyu: { direct: "mtop \u7B7E\u540D\u76F4\u8FDE", login: "\u5FC5\u9700" },
    jd: { direct: "\u8BE6\u60C5 SSR \u76F4\u8FDE\uFF08\u4EF7\u683C/\u89C4\u683C\uFF09\uFF1B\u641C\u7D22\u9700\u767B\u5F55\u6001\u6D4F\u89C8\u5668", login: "\u63A8\u8350" },
    pdd: { direct: "\u65E0\u76F4\u8FDE\uFF08anti-content \u5F3A\u7B7E\u540D\uFF09", login: "\u5FC5\u9700" },
    dewu: { direct: "\u65E0\u76F4\u8FDE\uFF0C\u6D4F\u89C8\u5668\u6E32\u67D3", login: "\u63A8\u8350" }
  };
  async function updatePlatCard() {
    const platform = $("#platform").value;
    const card = $("#platCard");
    if (!platform) {
      card.innerHTML = '<span class="muted">\u8BF7\u9009\u62E9\u5E73\u53F0\u67E5\u770B\u8054\u52A8\u4FE1\u606F\u3002</span>';
      return;
    }
    const meta = PLATFORM_META[platform] || { direct: "\u6D4F\u89C8\u5668\u6E32\u67D3", login: "\u2014" };
    card.innerHTML = `<span class="badge"><b>${esc($("#platform").selectedOptions[0]?.textContent || platform)}</b></span>
    <span class="badge">\u76F4\u8FDE\u901A\u9053\uFF1A${esc(meta.direct)}</span>
    <span id="pcLogin" class="badge">\u767B\u5F55\u6001\uFF1A\u68C0\u6D4B\u4E2D\u2026</span>
    <span id="pcProxy" class="badge">\u4EE3\u7406\u6C60\uFF1A\u2026</span>`;
    try {
      const c = await apiJson("/api/cookies");
      const has = (c.files || []).some((f) => f.startsWith(platform));
      const el = $("#pcLogin");
      if (el) {
        el.className = `badge ${has ? "ok" : "off"}`;
        el.innerHTML = `<span class="dot"></span>\u767B\u5F55\u6001\uFF1A${has ? "\u5DF2\u6709\uFF08\u91C7\u96C6\u81EA\u52A8\u6CE8\u5165\uFF09" : `\u65E0${meta.login === "\u5FC5\u9700" ? " \xB7 \u8BE5\u5E73\u53F0\u5FC5\u9700\uFF0C\u8BF7\u5230\u7CFB\u7EDF\u8BBE\u7F6E\u63D0\u53D6" : meta.login === "\u63A8\u8350" ? " \xB7 \u5EFA\u8BAE\u63D0\u53D6" : ""}`}`;
      }
    } catch {
      const el = $("#pcLogin");
      if (el) el.textContent = "\u767B\u5F55\u6001\uFF1A\u68C0\u6D4B\u5931\u8D25";
    }
    try {
      const p = await apiJson("/api/proxy");
      const okCount = p.proxies.filter((x) => x.cooldownUntil <= Date.now()).length;
      const el = $("#pcProxy");
      if (el) el.className = `badge ${okCount ? "ok" : "off"}`;
      if (el) el.textContent = `\u4EE3\u7406\u6C60\uFF1A${okCount}/${p.poolSize} \u53EF\u7528`;
    } catch {
      const el = $("#pcProxy");
      if (el) el.textContent = "\u4EE3\u7406\u6C60\uFF1A\u52A0\u8F7D\u5931\u8D25";
    }
  }
  function syncDataTypeUi() {
    const t = $("#dataType").value;
    const label = $("#queryLabel");
    const q = $("#query");
    if (t === "review" || t === "qa") {
      label.childNodes[0].textContent = "\u5546\u54C1\u94FE\u63A5\u6216 ItemId ";
      q.placeholder = "\u5982\uFF1Ahttps://item.jd.com/\u2026 \u6216 100012043978";
      $("#withDetailsWrap").hidden = true;
    } else {
      label.childNodes[0].textContent = "\u67E5\u8BE2\u8BCD / ItemId ";
      q.placeholder = "\u5982\uFF1A\u624B\u673A / item_123";
      $("#withDetailsWrap").hidden = false;
    }
    syncDetailLimitUi();
  }
  function syncDetailLimitUi() {
    const show = $("#dataType").value === "product" && $("#withDetails").checked;
    $("#detailLimitWrap").hidden = !show;
  }
  function syncJobDetailLimitUi() {
    const show = $("#jobType").value === "product" && $("#jobDetails").checked;
    if ($("#jobDetailLimitWrap")) $("#jobDetailLimitWrap").hidden = !show;
  }
  async function loadPlatforms() {
    const list = await apiJson("/api/platforms");
    const opts = list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    $("#platform").innerHTML = opts;
    $("#jobPlatform").innerHTML = opts;
    $("#dataPlatform").innerHTML = '<option value="">\u5168\u90E8\u5E73\u53F0</option>' + opts;
    const lgSel = $("#lgPlatform");
    if (lgSel) lgSel.innerHTML = opts;
  }
  var runLogState = { last: -1, timer: null };
  function logLine(l) {
    const box = $("#runLog");
    const div = document.createElement("div");
    div.textContent = `[${l.t}] ${l.msg}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }
  function startRunLogPolling() {
    const box = $("#runLog");
    box.hidden = false;
    box.innerHTML = "";
    runLogState.last = -1;
    clearInterval(runLogState.timer);
    runLogState.timer = setInterval(async () => {
      try {
        const d = await apiJson(`/api/logs?since=${runLogState.last}`);
        (d.lines || []).forEach(logLine);
        runLogState.last = d.last;
      } catch {
      }
    }, 1e3);
  }
  function stopRunLogPolling() {
    clearInterval(runLogState.timer);
    runLogState.timer = setTimeout(async () => {
      try {
        const d = await apiJson(`/api/logs?since=${runLogState.last}`);
        (d.lines || []).forEach(logLine);
        runLogState.last = d.last;
      } catch {
      }
    }, 1500);
  }
  async function loadStats() {
    const s = await apiJson("/api/stats");
    $("#stats").innerHTML = `
    <span>\u5546\u54C1 <b>${s.product}</b></span>
    <span>\u8BC4\u8BBA <b>${s.review}</b></span>
    <span>\u95EE\u7B54 <b>${s.qa}</b></span>`;
    return s;
  }
  var lastStatsKey = null;
  async function pollStats() {
    try {
      const s = await apiJson("/api/stats");
      const key = JSON.stringify(s);
      if (lastStatsKey !== null && key !== lastStatsKey) {
        loadStats();
        if (!drawerOpen) renderTable(currentType, true);
      }
      lastStatsKey = key;
    } catch {
    }
  }
  async function runCollect() {
    const platform = $("#platform").value;
    if (!platform) {
      $("#runResult").textContent = "\u8BF7\u5148\u9009\u62E9\u5177\u4F53\u5E73\u53F0\u518D\u8FD0\u884C\u91C7\u96C6\u3002";
      return;
    }
    const body = {
      platform,
      dataType: $("#dataType").value,
      strategy: $("#strategy").value,
      query: $("#query").value,
      limit: Number($("#limit").value),
      withDetails: $("#withDetails").checked,
      detailLimit: Number($("#detailLimit").value)
    };
    $("#runResult").textContent = "\u91C7\u96C6\u4E2D\u2026\uFF08\u4E0B\u65B9\u65E5\u5FD7\u5B9E\u65F6\u6EDA\u52A8\u5C55\u793A\u91C7\u96C6\u8FC7\u7A0B\uFF09";
    $("#runBtn").disabled = true;
    $("#stopBtn").hidden = false;
    $("#stopBtn").disabled = false;
    startRunLogPolling();
    try {
      const r = await apiJson("/api/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      $("#runResult").textContent = r.status === "stopped" ? "\u23F9 \u5DF2\u624B\u52A8\u505C\u6B62\u91C7\u96C6\u3002" + (r.message || "") : JSON.stringify(r, null, 2);
      if (r.status !== "stopped" && r.count > 0) {
        $("#runResult").innerHTML = `<span style="font-family:inherit">\u672C\u6B21\u5165\u5E93 ${r.count} \u6761\uFF08${esc(platform)}\uFF09\u3002</span> <button id="jumpData" class="btn-ghost" style="padding:3px 10px">\u67E5\u770B\u91C7\u96C6\u7ED3\u679C \u2192</button>`;
        $("#jumpData").addEventListener("click", () => {
          $("#dataPlatform").value = platform;
          pager.page = 1;
          $("#dataSearch").value = "";
          showPage("data");
        });
      }
      await loadStats();
      renderTable(body.dataType, true);
    } catch (e) {
      $("#runResult").textContent = "\u9519\u8BEF\uFF1A" + e.message;
    } finally {
      stopRunLogPolling();
      $("#runBtn").disabled = false;
      $("#stopBtn").hidden = true;
    }
  }
  async function stopCollect() {
    $("#stopBtn").disabled = true;
    $("#runResult").textContent = "\u6B63\u5728\u505C\u6B62\u2026\uFF08\u5F53\u524D\u7F51\u7EDC\u8BF7\u6C42\u5B8C\u6210\u540E\u4E0D\u518D\u7EE7\u7EED\uFF0C\u5DF2\u5165\u5E93\u6570\u636E\u4FDD\u7559\uFF09";
    try {
      await apiJson("/api/collect/stop", { method: "POST" });
    } catch (e) {
      $("#runResult").textContent = "\u505C\u6B62\u6307\u4EE4\u53D1\u9001\u5931\u8D25\uFF1A" + e.message;
      $("#stopBtn").disabled = false;
    }
  }
  function saveAsJob() {
    const platform = $("#platform").value;
    if (!platform) {
      $("#runResult").textContent = "\u8BF7\u5148\u9009\u62E9\u5E73\u53F0\u518D\u4FDD\u5B58\u4E3A\u5B9A\u65F6\u4EFB\u52A1\u3002";
      return;
    }
    const type = $("#dataType").value;
    $("#jobPlatform").value = platform;
    $("#jobType").value = type;
    $("#jobQuery").value = $("#query").value;
    $("#jobLimit").value = $("#limit").value;
    $("#jobDetails").checked = type === "product" ? $("#withDetails").checked : false;
    if ($("#jobDetailLimit")) $("#jobDetailLimit").value = $("#detailLimit").value || 3;
    syncJobDetailLimitUi();
    showPage("jobs");
    $("#jobResult").textContent = "\u5DF2\u4ECE\u91C7\u96C6\u5DE5\u4F5C\u53F0\u5E26\u5165\u5F53\u524D\u914D\u7F6E\uFF0C\u786E\u8BA4\u53C2\u6570\u540E\u70B9\u300C\u6DFB\u52A0\u4EFB\u52A1\u300D\u3002";
  }
  async function loadJobs() {
    const jobs = await apiJson("/api/jobs");
    const rows = jobs.map(
      (j) => `<tr>
      <td>${esc(j.id)}</td><td>${esc(j.platform)}</td><td>${esc(j.dataType)}</td>
      <td>${esc(j.query || "")}</td><td>${j.everyMinutes}</td>
      <td>${j.withDetails ? `\u662F\uFF08\u8BC4\u8BBA+\u95EE\u7B54+SPU/SKU\uFF0C\u8BE6\u60C5\u524D ${j.detailLimit || 3} \u4E2A\uFF09` : "\u5426"}</td><td>${j.enabled ? "\u2705" : "\u26D4"}</td>
      <td>
        <button data-run="${esc(j.id)}">\u8FD0\u884C</button>
        <button data-del="${esc(j.id)}">\u5220\u9664</button>
      </td></tr>`
    ).join("");
    $("#jobTable").innerHTML = `<thead><tr><th>ID</th><th>\u5E73\u53F0</th><th>\u7C7B\u578B</th><th>\u67E5\u8BE2</th><th>\u5468\u671F(\u5206)</th><th>\u5E26\u8BE6\u60C5</th><th>\u542F\u7528</th><th>\u64CD\u4F5C</th></tr></thead><tbody>${rows || '<tr><td colspan="8">\u6682\u65E0\u4EFB\u52A1</td></tr>'}</tbody>`;
    $("#jobTable").querySelectorAll("[data-run]").forEach(
      (b) => b.addEventListener("click", () => runJob(b.dataset.run))
    );
    $("#jobTable").querySelectorAll("[data-del]").forEach(
      (b) => b.addEventListener("click", () => delJob(b.dataset.del))
    );
  }
  async function loadRuns() {
    const runs = await apiJson("/api/jobs/runs");
    const rows = runs.map(
      (r) => `<tr><td>${esc(r.job_id)}</td><td>${esc(r.platform)}</td><td>${esc(r.data_type)}</td>
      <td>${esc(r.status)}</td><td>${r.count}</td><td>${esc((r.message || "").slice(0, 40))}</td>
      <td>${esc(fmtTime(r.finished_at))}</td></tr>`
    ).join("");
    $("#runTable").innerHTML = `<thead><tr><th>\u4EFB\u52A1</th><th>\u5E73\u53F0</th><th>\u7C7B\u578B</th><th>\u72B6\u6001</th><th>\u6761\u6570</th><th>\u4FE1\u606F</th><th>\u5B8C\u6210\u65F6\u95F4</th></tr></thead><tbody>${rows || '<tr><td colspan="7">\u6682\u65E0\u8FD0\u884C\u8BB0\u5F55</td></tr>'}</tbody>`;
  }
  async function addJob() {
    const body = {
      platform: $("#jobPlatform").value,
      dataType: $("#jobType").value,
      query: $("#jobQuery").value,
      everyMinutes: Number($("#jobEvery").value),
      limit: Number($("#jobLimit").value),
      withDetails: $("#jobDetails").checked,
      detailLimit: Number($("#jobDetailLimit")?.value) || 3,
      enabled: $("#jobEnabled").checked
    };
    $("#jobResult").textContent = "\u6DFB\u52A0\u4E2D\u2026";
    try {
      const r = await apiJson("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      $("#jobResult").textContent = "\u5DF2\u6DFB\u52A0\uFF1A" + JSON.stringify(r);
      await loadJobs();
    } catch (e) {
      $("#jobResult").textContent = "\u9519\u8BEF\uFF1A" + e.message;
    }
  }
  async function runJob(id) {
    try {
      const r = await apiJson("/api/jobs/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      $("#jobResult").textContent = "\u8FD0\u884C\u7ED3\u679C\uFF1A" + JSON.stringify(r);
      await loadRuns();
      await loadStats();
    } catch (e) {
      $("#jobResult").textContent = "\u9519\u8BEF\uFF1A" + e.message;
    }
  }
  async function delJob(id) {
    try {
      await api(`/api/jobs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadJobs();
    } catch (e) {
      $("#jobResult").textContent = "\u9519\u8BEF\uFF1A" + e.message;
    }
  }
  var lastTest = {};
  async function loadProxy() {
    try {
      const p = await apiJson("/api/proxy");
      const bad = p.proxies.filter((x) => x.cooldownUntil > Date.now()).length;
      $("#proxyInfo").textContent = `\u4EE3\u7406\u6C60\uFF1A\u5171 ${p.poolSize} \u4E2A\uFF08\u51B7\u5374\u4E2D ${bad} \u4E2A\uFF09`;
      const rows = p.proxies.map((x) => {
        const t = lastTest[x.proxy];
        let speed, status;
        if (t) {
          speed = t.ok ? `\u2705 ${t.ms}ms` : "\u274C \u5931\u8D25";
          status = t.ok ? x.failures > 0 ? `\u6210\u529F(\u6B64\u524D\u5931\u8D25${x.failures}\u6B21)` : "\u6B63\u5E38" : esc(t.error || "\u5931\u8D25");
        } else {
          speed = x.lastLatencyMs != null ? x.lastLatencyMs + "ms" : "\u672A\u6D4B\u901F";
          status = x.cooldownUntil > Date.now() ? "\u2744\uFE0F\u51B7\u5374" : x.failures > 0 ? `\u5931\u8D25${x.failures}\u6B21` : "\u6B63\u5E38";
        }
        return `<tr><td>${esc(x.proxy)}</td><td>${speed}</td><td>${status}</td><td><button data-delproxy="${esc(x.proxy)}" class="btn-danger" style="padding:2px 8px">\u5220\u9664</button></td></tr>`;
      }).join("");
      $("#proxyList").innerHTML = p.proxies.length ? `<table><thead><tr><th>\u4EE3\u7406</th><th>\u6D4B\u901F</th><th>\u72B6\u6001</th><th>\u64CD\u4F5C</th></tr></thead><tbody>${rows}</tbody></table>` : "\u4EE3\u7406\u6C60\u4E3A\u7A7A\uFF1A\u76F4\u8FDE\u672C\u673A IP \u6293\u53D6\u3002\u5EFA\u8BAE\u6DFB\u52A0 VPN \u672C\u5730\u7AEF\u53E3\u6216\u4EE3\u7406\u670D\u52A1\uFF0C\u907F\u514D\u5BB6\u5EAD IP \u76F4\u63A5\u66B4\u9732\u3002";
      $("#proxyList").querySelectorAll("[data-delproxy]").forEach(
        (b) => b.addEventListener("click", async () => {
          if (!confirm(`\u5220\u9664\u4EE3\u7406 ${b.dataset.delproxy}\uFF1F`)) return;
          await api(`/api/proxy?proxy=${encodeURIComponent(b.dataset.delproxy)}`, { method: "DELETE" });
          delete lastTest[b.dataset.delproxy];
          await loadProxy();
        })
      );
    } catch (e) {
      $("#proxyInfo").textContent = "\u4EE3\u7406\u6C60\u52A0\u8F7D\u5931\u8D25\uFF1A" + e.message;
    }
  }
  async function addProxyUi() {
    let proxy = $("#proxyInput").value.trim();
    if (!proxy) {
      alert("\u8BF7\u5148\u586B\u5199\u4EE3\u7406\u5730\u5740\uFF0C\u5982 127.0.0.1:7890");
      return;
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy)) proxy = "http://" + proxy;
    try {
      const r = await apiJson("/api/proxy/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxy })
      });
      $("#proxyInput").value = "";
      await loadProxy();
      if (r.added === false) {
        alert("\u8BE5\u4EE3\u7406\u5DF2\u5728\u6C60\u4E2D\uFF0C\u65E0\u9700\u91CD\u590D\u6DFB\u52A0\u3002");
      } else {
        $("#proxyInfo").textContent = "\u5DF2\u6DFB\u52A0\uFF0C\u6D4B\u901F\u4E2D\u2026\uFF08\u6700\u591A 6 \u79D2\uFF09";
        try {
          const t = await apiJson("/api/proxy/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          });
          (t.results || []).forEach((x) => lastTest[x.proxy] = x);
        } catch {
        }
        await loadProxy();
      }
    } catch (e) {
      alert("\u6DFB\u52A0\u5931\u8D25\uFF1A" + e.message);
    }
  }
  async function testProxiesUi() {
    if (!Number((await apiJson("/api/proxy")).poolSize)) {
      $("#proxyInfo").textContent = "\u4EE3\u7406\u6C60\u4E3A\u7A7A\uFF0C\u65E0\u53EF\u6D4B\u901F\u7684\u4EE3\u7406\u3002\u8BF7\u5148\u6DFB\u52A0\u3002";
      return;
    }
    $("#proxyInfo").textContent = "\u6D4B\u901F\u4E2D\u2026\uFF08\u6BCF\u6761\u6700\u591A 6 \u79D2\uFF0C\u6D4B\u5B8C\u81EA\u52A8\u5C55\u793A\u6BCF\u6761\u5EF6\u8FDF/\u5931\u8D25\u539F\u56E0\uFF09";
    try {
      const r = await apiJson("/api/proxy/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      lastTest = {};
      (r.results || []).forEach((x) => lastTest[x.proxy] = x);
      await loadProxy();
      const ok = r.results.filter((x) => x.ok);
      const fail = r.results.filter((x) => !x.ok);
      let summary = `\u6D4B\u901F\u5B8C\u6210\uFF1A${ok.length}/${r.results.length} \u6761\u53EF\u7528`;
      if (ok.length) summary += `\uFF0C\u5EF6\u8FDF ${Math.min(...ok.map((x) => x.ms))}-${Math.max(...ok.map((x) => x.ms))}ms`;
      if (fail.length) summary += `\uFF1B\u5931\u8D25 ${fail.length} \u6761\uFF08\u539F\u56E0\u89C1\u5217\u8868\uFF0C\u5E38\u89C1\uFF1AVPN \u672A\u8FD0\u884C / \u7AEF\u53E3\u586B\u9519 / \u4EE3\u7406\u9700\u8981\u8BA4\u8BC1\uFF09`;
      $("#proxyInfo").textContent = summary;
    } catch (e) {
      $("#proxyInfo").textContent = "\u6D4B\u901F\u5931\u8D25\uFF1A" + e.message;
    }
  }
  function launchCookieExtract(platform, statusEl, onSaved) {
    statusEl.textContent = "\u6B63\u5728\u5F39\u51FA\u6D4F\u89C8\u5668\u2026\uFF08\u7EA6\u9700 2~5 \u79D2\uFF09";
    let baseline;
    (async () => {
      try {
        baseline = JSON.stringify((await apiJson("/api/cookies")).fingerprint || {});
        await apiJson("/api/cookies/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform })
        });
        statusEl.textContent = `\u6D4F\u89C8\u5668\u5DF2\u5F39\u51FA\uFF1A\u8BF7\u5728\u7A97\u53E3\u5185\u767B\u5F55\u300C${platform}\u300D\uFF0C\u767B\u5F55\u6210\u529F\u540E\u81EA\u52A8\u4FDD\u5B58\uFF0810 \u5206\u949F\u5185\u6709\u6548\uFF09\u3002\u4FDD\u5B58\u540E\u81EA\u52A8\u91CD\u6D4B\u5E76\u5237\u65B0\u672C\u8868\u3002`;
      } catch (e) {
        statusEl.textContent = "\u542F\u52A8\u5931\u8D25\uFF1A" + e.message;
        return;
      }
      const t0 = Date.now();
      const timer = setInterval(async () => {
        try {
          const c = await apiJson("/api/cookies");
          if (JSON.stringify(c.fingerprint || c.files) !== baseline) {
            clearInterval(timer);
            statusEl.textContent = `\u2705 ${platform} \u767B\u5F55\u6001\u5DF2\u4FDD\u5B58\uFF0C\u6B63\u5728\u91CD\u65B0\u68C0\u6D4B\u6709\u6548\u6027\u2026`;
            if ($("#platform").value === platform) updatePlatCard();
            if (onSaved) await onSaved(platform);
            return;
          }
          if (Date.now() - t0 > 6e5) {
            clearInterval(timer);
            statusEl.textContent = "\u7B49\u5F85\u8D85\u65F6\uFF0810 \u5206\u949F\uFF09\u672A\u68C0\u6D4B\u5230\u4FDD\u5B58\u3002\u82E5\u5DF2\u767B\u5F55\u4ECD\u672A\u4FDD\u5B58\uFF0C\u8BF7\u91CD\u8BD5\u4E00\u6B21\u3002";
            return;
          }
        } catch {
        }
      }, 3e3);
    })();
  }
  function reloginUi(platform) {
    if ([...$("#platform").options].some((o) => o.value === platform)) $("#platform").value = platform;
    launchCookieExtract(platform, $("#lgMeta"), async (p) => {
      await loadLoginStatus();
      checkLoginUi(p);
    });
  }
  var ckModalData = [];
  async function viewCookies(platform) {
    const p = platform || "vip";
    $("#ckModalTitle").textContent = `\uFF08${p}\uFF09`;
    $("#cookieModal").hidden = false;
    const body = $("#ckModalBody");
    body.textContent = "\u52A0\u8F7D\u4E2D\u2026";
    try {
      const r = await apiJson(`/api/cookies/view?platform=${encodeURIComponent(p)}`);
      ckModalData = r.cookies || [];
      const rows = ckModalData.map((c, i) => {
        let exp = "\u4F1A\u8BDD";
        if (c.expires != null && Number.isFinite(Number(c.expires)) && Number(c.expires) > 0) {
          const d = new Date(Number(c.expires) * 1e3);
          exp = isNaN(d.getTime()) ? String(c.expires) : fmtTime(d.toISOString());
        }
        return `<tr><td>${i + 1}</td><td><code>${esc(c.name)}</code></td><td class="ck-val" title="${esc(c.value)}">${esc(
          c.value.length > 70 ? c.value.slice(0, 70) + "\u2026" : c.value
        )}</td><td>${esc(c.domain || "")}</td><td>${exp}</td></tr>`;
      }).join("");
      body.innerHTML = `<p class="count">\u6587\u4EF6\uFF1A${esc(r.file)} \uFF5C \u5171 ${r.count} \u6761 \uFF5C \u91C7\u96C6\u65F6\u81EA\u52A8\u6CE8\u5165\u5168\u90E8\u6761\u76EE</p><table><thead><tr><th>#</th><th>\u540D\u79F0</th><th>\u503C\uFF08\u60AC\u505C\u770B\u5168\u6587\uFF09</th><th>\u57DF</th><th>\u6709\u6548\u671F\u81F3</th></tr></thead><tbody>${rows}</tbody></table>`;
    } catch (e) {
      body.textContent = "\u52A0\u8F7D\u5931\u8D25\uFF1A" + e.message;
      ckModalData = [];
    }
  }
  async function copyCookiesJson() {
    if (!ckModalData.length) {
      alert("\u6682\u65E0\u53EF\u590D\u5236\u7684 Cookie \u5185\u5BB9\u3002");
      return;
    }
    const text = JSON.stringify(ckModalData, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      alert(`\u5DF2\u590D\u5236 ${ckModalData.length} \u6761 Cookie \u7684 JSON \u5230\u526A\u8D34\u677F\u3002`);
    } catch {
      const blob = new Blob([text], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "cookies.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }
  var LOGIN_STATUS_TEXT = {
    valid: "\u5DF2\u767B\u5F55 \xB7 \u6709\u6548",
    invalid: "\u5DF2\u5931\u6548",
    probable: "\u7591\u4F3C\u6709\u6548\uFF08\u672A\u5B9E\u6D4B\uFF09",
    expired: "Cookie \u5DF2\u5168\u90E8\u8FC7\u671F",
    absent: "\u672A\u767B\u5F55\uFF08\u65E0 Cookie\uFF09",
    unknown: "\u65E0\u6CD5\u5224\u5B9A",
    none: "\u65E0\u9700\u767B\u5F55"
  };
  function loginBadgeCls(status) {
    if (status === "valid") return "ok";
    if (status === "none") return "";
    return "off";
  }
  async function loadLoginStatus() {
    const box = $("#loginTable");
    const meta = $("#lgMeta");
    try {
      const d = await apiJson("/api/login/status");
      const rows = Object.values(d.results || {});
      meta.textContent = `\u4E0A\u6B21\u68C0\u6D4B\uFF1A${d.at ? fmtTime(d.at) : "\u5C1A\u672A\u68C0\u6D4B"} \uFF5C \u5B9A\u65F6\u68C0\u6D4B\uFF1A${d.intervalMin > 0 ? `\u6BCF ${d.intervalMin} \u5206\u949F` : "\u5DF2\u5173\u95ED"}`;
      const trs = rows.map((r) => {
        const need = r.needLogin === "\u5FC5\u9700" ? '<b style="color:#9a3412">\u5FC5\u9700</b>' : r.needLogin === "\u63A8\u8350" ? "\u63A8\u8350" : "\u4E0D\u9700\u8981";
        const cookie = r.count > 0 ? `<a href="javascript:void(0)" class="ck-link" data-ckview="${esc(r.platform)}" title="\u70B9\u51FB\u67E5\u770B Cookie \u660E\u7EC6">${r.count} \u6761\uFF08\u8FC7\u671F ${r.expired}\uFF09</a>` : '<span class="muted">\u65E0</span>';
        const statusCell = `<span class="badge ${loginBadgeCls(r.status)}"><span class="dot"></span>${esc(LOGIN_STATUS_TEXT[r.status] || r.status)}</span>`;
        const ops = `<div style="display:flex;flex-direction:column;gap:4px">
             <div style="display:flex;gap:6px;align-items:center">
               <button data-lgrelogin="${esc(r.platform)}" class="btn-ghost btn-sm">\u{1F511} ${r.count > 0 ? "\u91CD\u65B0\u767B\u5F55" : "\u767B\u5F55"}</button>
               <button data-lgcheck="${esc(r.platform)}" style="padding:2px 10px;margin-left:auto">\u68C0\u6D4B</button>
             </div>
             <button data-lgbrowser="${esc(r.platform)}" class="btn-ghost btn-sm" title="headless \u8BFB\u53D6\u63D0\u53D6\u6D4F\u89C8\u5668\u6863\u6848\u7684\u5B9E\u65F6\u767B\u5F55\u6001\u5E76\u5F39\u7A97\u5C55\u793A\uFF08\u5DF2\u767B\u5F55\u5219\u540C\u6B65\u4E3A\u91C7\u96C6\u7528\u5FEB\u7167\uFF0C\u7EA6 10~40 \u79D2\uFF09">\u{1F310} \u83B7\u53D6\u6B64\u6D4F\u89C8\u5668\u6001</button>
           </div>`;
        return `<tr>
        <td>${esc(r.platform)}</td><td>${need}</td><td>${cookie}</td>
        <td>${statusCell}</td>
        <td class="lg-detail" title="${esc(r.detail || "")}">${esc(r.detail || "")}</td>
        <td>${r.checkedAt ? timeCell(r.checkedAt) : '<span class="muted">\u2014</span>'}</td>
        <td>${ops}</td>
      </tr>`;
      }).join("");
      box.innerHTML = `<table><thead><tr><th>\u5E73\u53F0</th><th>\u9700\u8981\u767B\u5F55</th><th>\u5DF2\u5B58 Cookie</th><th>\u767B\u5F55\u72B6\u6001</th><th>\u8BF4\u660E</th><th>\u68C0\u6D4B\u65F6\u95F4</th><th>\u64CD\u4F5C</th></tr></thead><tbody>${trs}</tbody></table>`;
      box.querySelectorAll("[data-lgcheck]").forEach((b) => b.addEventListener("click", () => checkLoginUi(b.dataset.lgcheck)));
      box.querySelectorAll("[data-lgrelogin]").forEach((b) => b.addEventListener("click", () => reloginUi(b.dataset.lgrelogin)));
      box.querySelectorAll("[data-lgbrowser]").forEach((b) => b.addEventListener("click", () => checkBrowserUi(b.dataset.lgbrowser)));
      box.querySelectorAll("[data-ckview]").forEach((a) => a.addEventListener("click", () => viewCookies(a.dataset.ckview)));
    } catch (e) {
      meta.textContent = "\u767B\u5F55\u72B6\u6001\u52A0\u8F7D\u5931\u8D25\uFF1A" + e.message;
    }
  }
  async function checkLoginUi(platform) {
    const meta = $("#lgMeta");
    const btn = box_queryLoginBtn(platform);
    const row = btn ? btn.closest("tr") : null;
    const statusCell = row ? row.cells[3] : null;
    const detailCell = row ? row.cells[4] : null;
    const oldStatusCell = statusCell ? statusCell.innerHTML : "";
    if (btn) btn.disabled = true;
    if (statusCell) statusCell.innerHTML = '<span class="badge"><span class="dot" style="background:#b45309"></span>\u68C0\u6D4B\u4E2D\u2026</span>';
    if (detailCell) detailCell.textContent = "\u6B63\u5728\u53D1\u771F\u5B9E\u8BF7\u6C42\u9A8C\u8BC1\u8BE5\u5E73\u53F0\u767B\u5F55\u6001\uFF0C\u7EA6\u9700\u6570\u79D2\u5230\u6570\u5341\u79D2\u2026";
    meta.textContent = `\u6B63\u5728\u68C0\u6D4B ${platform} \u767B\u5F55\u6001\uFF08\u771F\u5B9E\u8BF7\u6C42\u9A8C\u8BC1\uFF0C\u7EA6\u9700\u6570\u79D2\u5230\u6570\u5341\u79D2\uFF09\u2026`;
    try {
      const r = await apiJson("/api/login/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform })
      });
      meta.textContent = `${platform} \u68C0\u6D4B\u5B8C\u6210\uFF1A${LOGIN_STATUS_TEXT[r.status] || r.status}${r.detail ? ` \xB7 ${r.detail}` : ""}`;
      if (statusCell) {
        statusCell.innerHTML = `<span class="badge ${loginBadgeCls(r.status)}"><span class="dot"></span>${esc(LOGIN_STATUS_TEXT[r.status] || r.status)}</span>`;
        if (detailCell) detailCell.textContent = r.detail || "";
      } else {
        await loadLoginStatus();
      }
      if ($("#platform").value === platform) updatePlatCard();
    } catch (e) {
      meta.textContent = `\u68C0\u6D4B\u5931\u8D25\uFF1A${e.message}`;
      if (statusCell) statusCell.innerHTML = oldStatusCell;
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  async function checkBrowserUi(platform) {
    const meta = $("#lgMeta");
    const btn = box_queryLoginBtn(platform, "data-lgbrowser");
    const row = btn ? btn.closest("tr") : null;
    const statusCell = row ? row.cells[3] : null;
    if (btn) btn.disabled = true;
    if (statusCell) statusCell.innerHTML = '<span class="badge"><span class="dot" style="background:#b45309"></span>\u8BFB\u53D6\u6D4F\u89C8\u5668\u6863\u6848\u4E2D\u2026</span>';
    meta.textContent = `\u6B63\u5728 headless \u8BFB\u53D6 ${platform} \u7684\u63D0\u53D6\u6D4F\u89C8\u5668\u6863\u6848\uFF08\u7EA6 10~40 \u79D2\uFF0C\u8BF7\u52FF\u540C\u65F6\u5BF9\u8BE5\u5E73\u53F0\u70B9\u300C\u{1F511}\u767B\u5F55\u300D\uFF09\u2026`;
    try {
      const r = await apiJson("/api/login/check-browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform })
      });
      const textMap = { "logged-in": "\u5DF2\u767B\u5F55", guest: "\u6E38\u5BA2\u6001\uFF08\u6863\u6848\u5185\u65E0\u767B\u5F55 Cookie\uFF09", uncertain: "\u7591\u4F3C\u767B\u5F55\u4F46\u672A\u786E\u8BA4", "no-profile": "\u6682\u65E0\u6D4F\u89C8\u5668\u6863\u6848\uFF08\u8BF7\u5148\u{1F511}\u767B\u5F55\uFF09", unsupported: "\u8BE5\u5E73\u53F0\u6682\u4E0D\u652F\u6301\u6D4F\u89C8\u6001\u5224\u5B9A", error: "\u8BFB\u53D6\u5931\u8D25" };
      meta.textContent = `${platform} \u6B64\u6D4F\u89C8\u5668\u6001\uFF1A${textMap[r.status] || r.status}${r.detail ? ` \xB7 ${r.detail}` : ""}`;
      const modal = $("#cookieModal");
      $("#ckModalTitle").textContent = `\u6B64\u6D4F\u89C8\u5668\u6001\uFF08${platform}\uFF09`;
      modal.hidden = false;
      const body = $("#ckModalBody");
      const cookies = Array.isArray(r.cookies) ? r.cookies : [];
      ckModalData = cookies;
      if (r.status === "no-profile" || r.status === "unsupported" || r.status === "error") {
        body.innerHTML = `<p class="count">${esc(r.detail || textMap[r.status] || "")}</p>`;
      } else {
        const rows = cookies.map((c, i) => {
          let exp = "\u4F1A\u8BDD";
          if (c.expires != null && Number.isFinite(Number(c.expires)) && Number(c.expires) > 0) {
            const d = new Date(Number(c.expires) * 1e3);
            exp = isNaN(d.getTime()) ? String(c.expires) : fmtTime(d.toISOString());
          }
          return `<tr><td>${i + 1}</td><td><code>${esc(c.name)}</code></td><td class="ck-val" title="${esc(c.value)}">${esc(String(c.value).slice(0, 26))}${String(c.value).length > 26 ? "\u2026" : ""}</td><td>${esc(c.domain || "")}</td><td>${exp}</td></tr>`;
        }).join("");
        body.innerHTML = `<p class="count">\u6863\u6848\u5185\u5B9E\u65F6\u8BFB\u53D6\u5230 <b>${cookies.length}</b> \u6761 Cookie \uFF5C \u5224\u5B9A\uFF1A<b>${esc(textMap[r.status] || r.status)}</b>${r.saved ? " \uFF5C <b>\u5DF2\u540C\u6B65\u4E3A\u91C7\u96C6\u7528\u5FEB\u7167</b>" : ""}<br/><span class="muted">${esc(r.detail || "")}</span></p>` + (cookies.length ? `<table><thead><tr><th>#</th><th>\u540D\u79F0</th><th>\u503C\uFF08\u60AC\u505C\u770B\u5168\u6587\uFF09</th><th>\u57DF</th><th>\u6709\u6548\u671F</th></tr></thead><tbody>${rows}</tbody></table>` : "");
      }
      await loadLoginStatus();
    } catch (e) {
      meta.textContent = `\u6D4F\u89C8\u6001\u8BFB\u53D6\u5931\u8D25\uFF1A${e.message}`;
      await loadLoginStatus();
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  function box_queryLoginBtn(platform, attr = "data-lgcheck") {
    return document.querySelector(`#loginTable [${attr}="${platform}"]`);
  }
  async function checkAllLoginUi() {
    const meta = $("#lgMeta");
    meta.textContent = "\u6B63\u5728\u5168\u91CF\u68C0\u6D4B\u6240\u6709\u5E73\u53F0\uFF08\u9010\u4E2A\u53D1\u771F\u5B9E\u8BF7\u6C42\uFF0C\u7EA6\u9700 1~3 \u5206\u949F\uFF09\u2026";
    $("#lgCheckAll").disabled = true;
    try {
      await apiJson("/api/login/check-all", { method: "POST" });
      meta.textContent = "\u5168\u91CF\u68C0\u6D4B\u5B8C\u6210\u3002";
      await loadLoginStatus();
      updatePlatCard();
    } catch (e) {
      meta.textContent = "\u5168\u91CF\u68C0\u6D4B\u5931\u8D25\uFF1A" + e.message;
    } finally {
      $("#lgCheckAll").disabled = false;
    }
  }
  async function saveLoginInterval() {
    const v = Number($("#lgInterval").value);
    if (!Number.isFinite(v) || v < 0) {
      $("#lgMeta").textContent = "\u95F4\u9694\u9700\u4E3A \u22650 \u7684\u6574\u6570\u5206\u949F\uFF080=\u5173\u95ED\u5B9A\u65F6\u68C0\u6D4B\uFF09\u3002";
      return;
    }
    try {
      await apiJson("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginCheckMin: v })
      });
      $("#lgMeta").textContent = v > 0 ? `\u5DF2\u4FDD\u5B58\uFF1A\u6BCF ${v} \u5206\u949F\u81EA\u52A8\u68C0\u6D4B\u4E00\u6B21\u767B\u5F55\u6001\uFF08\u7ACB\u5373\u751F\u6548\uFF09\u3002` : "\u5DF2\u4FDD\u5B58\uFF1A\u5B9A\u65F6\u68C0\u6D4B\u5DF2\u5173\u95ED\u3002";
      await loadLoginStatus();
    } catch (e) {
      $("#lgMeta").textContent = "\u4FDD\u5B58\u5931\u8D25\uFF1A" + e.message;
    }
  }
  async function saveLoginCookie() {
    const platform = $("#lgPlatform").value;
    const raw = $("#lgCookieJson").value.trim();
    const box = $("#lgSaveResult");
    box.hidden = false;
    if (!raw) {
      box.textContent = "\u8BF7\u5148\u7C98\u8D34 Cookie JSON\uFF08\u6570\u7EC4\u683C\u5F0F\uFF09\u3002";
      return;
    }
    let cookies;
    try {
      cookies = JSON.parse(raw);
    } catch (e) {
      box.textContent = "JSON \u89E3\u6790\u5931\u8D25\uFF1A" + e.message;
      return;
    }
    box.textContent = "\u4FDD\u5B58\u4E2D\u2026";
    try {
      const r = await apiJson("/api/login/save-cookie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, cookies })
      });
      box.textContent = `\u2705 \u5DF2\u4FDD\u5B58 ${r.count} \u6761 Cookie \u5230 data/cookies/${platform}.json\u3002
\u767B\u5F55\u72B6\u6001\uFF1A${LOGIN_STATUS_TEXT[r.login?.status] || r.login?.status}
${r.login?.detail || ""}`;
      $("#lgCookieJson").value = "";
      await loadLoginStatus();
      if ($("#platform").value === platform) updatePlatCard();
    } catch (e) {
      box.textContent = "\u4FDD\u5B58\u5931\u8D25\uFF1A" + e.message;
    }
  }
  var testRunning = false;
  function testStepIcon(s) {
    return s.ok ? "\u2705" : (s.detail || "").startsWith("\u8DF3\u8FC7") || (s.detail || "").startsWith("\u8BE5\u5E73\u53F0\u6682\u672A") ? "\u23ED" : "\u274C";
  }
  async function runDiagnoseInline(preEl, platform, url, kind) {
    preEl.hidden = false;
    preEl.textContent = "\u5B57\u6BB5\u8BCA\u65AD\u4E2D\u2026\uFF08\u62C9\u53D6\u9875\u9762\u5E76\u6838\u5BF9\u6BCF\u4E2A\u5B57\u6BB5\u7684\u9009\u62E9\u5668\u547D\u4E2D\uFF09";
    try {
      const r = await apiJson("/api/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, url, kind })
      });
      if (!r.ok) {
        preEl.textContent = "\u8BCA\u65AD\u5931\u8D25\uFF1A" + (r.reason || r.error || "\u672A\u77E5\u539F\u56E0");
        return;
      }
      const fieldRows = (r.fields || []).map((f) => `<tr><td>${esc(f.field)}</td><td><code>${esc(f.selector)}</code></td><td>${f.matched}</td><td>${esc((f.sample || []).join(" \uFF5C ").slice(0, 60) || "\u2014")}</td></tr>`).join("");
      preEl.innerHTML = `<p style="margin:0 0 6px">\u9875\u9762 ${(r.htmlSize / 1024).toFixed(0)}KB \uFF5C \u53EF\u7528\u7B56\u7565\uFF1A${esc(r.strategy)} \uFF5C \u5EFA\u8BAE\uFF1A${esc(r.advice)}</p><table><thead><tr><th>\u5B57\u6BB5</th><th>\u9009\u62E9\u5668</th><th>\u547D\u4E2D</th><th>\u6837\u4F8B</th></tr></thead><tbody>${fieldRows}</tbody></table>`;
    } catch (e) {
      preEl.textContent = "\u8BCA\u65AD\u5931\u8D25\uFF1A" + e.message;
    }
  }
  async function runTestUi() {
    if (testRunning) return;
    const platform = $("#platform").value;
    if (!platform) {
      $("#runResult").textContent = "\u8BF7\u5148\u9009\u62E9\u5E73\u53F0\uFF0C\u518D\u4E00\u952E\u6D4B\u8BD5\u3002";
      return;
    }
    const dataType = $("#dataType").value;
    const query = $("#query").value.trim() || "\u624B\u673A";
    const config = {
      platform,
      dataType,
      query,
      itemId: dataType === "review" || dataType === "qa" ? query : ""
    };
    $("#testModalMeta").textContent = `\uFF08${platform} \xB7 ${dataType} \xB7 ${query.slice(0, 24)}\uFF09`;
    const body = $("#testModalBody");
    $("#testModal").hidden = false;
    testRunning = true;
    body.innerHTML = '<p class="count">\u6D4B\u8BD5\u4E2D\u2026\uFF08\u6BCF\u6B65\u8D70\u5B8C\u6574\u5F15\u64CE\uFF1A\u4EE3\u7406\u6C60 + \u6307\u7EB9 + \u6D4F\u89C8\u5668\u6E32\u67D3\uFF1B\u5546\u54C1\u7C7B\u578B\u8D70 \u5217\u8868\u2192\u8BE6\u60C5\u2192\u8BC4\u4EF7\u2192\u95EE\u7B54 \u5168\u94FE\u8DEF\uFF0C\u7EA6\u9700 10~120 \u79D2\uFF09</p>';
    try {
      const r = await apiJson("/api/test-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      const blocks = r.steps.map((s) => {
        const urlLine = s.url ? `<p class="test-step-url">\u6700\u7EC8\u94FE\u63A5\uFF1A<a href="${esc(s.url.startsWith("http") ? s.url : "https://" + s.url)}" target="_blank" rel="noopener">${esc(s.url.slice(0, 110))}</a></p>` : "";
        const extras = [];
        if (s.responseText) {
          extras.push(
            `<details><summary style="cursor:pointer;font-size:12px;color:var(--accent)">\u5C55\u5F00\u54CD\u5E94\u5185\u5BB9</summary><pre class="test-pre">${esc(s.responseText)}</pre></details>`
          );
        }
        if (s.dataText && s.dataText !== s.responseText) {
          extras.push(
            `<details><summary style="cursor:pointer;font-size:12px;color:var(--accent)">\u5C55\u5F00\u63D0\u53D6\u540E\u7684\u6570\u636E</summary><pre class="test-pre">${esc(s.dataText)}</pre></details>`
          );
        }
        return `<div class="test-step" data-key="${esc(s.key)}">
          <p class="test-step-head">
            <b>${testStepIcon(s)} ${esc(s.label)}</b>
            <span class="badge ${s.ok ? "ok" : "off"}">${s.ok ? "\u901A\u8FC7" : "\u672A\u901A\u8FC7"}</span>
            ${s.count ? `<span class="badge">${s.count} \u6761</span>` : ""}
            ${s.saved ? `<span class="badge ok">\u5165\u5E93 ${s.saved}</span>` : ""}
            ${s.ms ? `<span class="badge">${(s.ms / 1e3).toFixed(1)}s</span>` : ""}
            <button class="btn-ghost" data-diag="${esc(s.key)}" data-url="${esc(s.url)}" style="padding:2px 10px;margin-left:auto">\u{1F52C} \u5B57\u6BB5\u8BCA\u65AD</button>
          </p>
          ${urlLine}
          <p class="test-detail">${esc(s.detail || "")}</p>
          ${extras.join("\n")}
          <pre class="test-pre diag-result" hidden></pre>
        </div>`;
      }).join("\n");
      const pass = r.steps.filter((s) => s.ok).length;
      const savedNote = (r.savedTotal || 0) > 0 ? `\u901A\u8FC7\u6B65\u9AA4\u7684\u6570\u636E\u5DF2\u81EA\u52A8\u5165\u5E93 ${r.savedTotal} \u6761\uFF08\u6309\u94FE\u63A5\u53BB\u91CD\uFF09` : "\u672C\u6B21\u6D4B\u8BD5\u65E0\u5165\u5E93\u6570\u636E\uFF08\u672A\u901A\u8FC7\u6216\u4E3A\u7A7A\u7ED3\u679C\uFF09";
      body.innerHTML = `<p class="count" style="margin:0 0 8px">\u6D4B\u8BD5\u76EE\u6807\uFF1A${esc(r.target || "\u2014")} \uFF5C \u901A\u8FC7 ${pass}/${r.steps.length} \u9879 \uFF5C ${esc(savedNote)}</p>${blocks}`;
      body.querySelectorAll("[data-diag]").forEach(
        (b) => b.addEventListener("click", () => {
          const stepEl = b.closest(".test-step");
          const pre = stepEl.querySelector(".diag-result");
          runDiagnoseInline(pre, platform, b.dataset.url, "product");
        })
      );
    } catch (e) {
      body.innerHTML = `<p style="color:#9a3412">\u6D4B\u8BD5\u5931\u8D25\uFF1A${esc(e.message)}</p>`;
    } finally {
      testRunning = false;
    }
  }
  var FP_MODE_TEXT = { mixed: "\u6DF7\u5408\u7AEF", desktop: "\u4EC5\u684C\u9762\u7AEF", mobile: "\u4EC5\u624B\u673A\u7AEF" };
  async function loadFingerprintStatus() {
    try {
      const f = await apiJson("/api/fingerprint/spawn");
      if ($("#fpMode") && f.mode) $("#fpMode").value = f.mode;
    } catch {
    }
  }
  async function appendFingerprints() {
    const btn = $("#fpAppend");
    const count = $("#fpGenCount").value;
    const kind = $("#fpGenKind").value;
    btn.disabled = true;
    try {
      const r = await apiJson("/api/fingerprint/append", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count, kind })
      });
      const sample = r.samples.map((s) => `\xB7 ${s.device}\uFF08${s.viewport[0]}\xD7${s.viewport[1]}\uFF09`).join("\n");
      $("#fpResult").textContent = `\u2705 \u5DF2\u751F\u6210 ${r.added} \u5957\u300C${kind === "desktop" ? "\u4EC5\u684C\u9762" : "\u4EC5\u624B\u673A"}\u300D\u6863\u6848\u5E76\u5165\u6C60\uFF0C\u5168\u6C60\u73B0\u6709 ${r.poolSize} \u5957\uFF08\u7AEF\u578B\u8303\u56F4\u4FDD\u5B58\u540E\u6309\u5B50\u6C60\u62BD\u53D6\uFF09\u3002
\u6837\u4F8B\uFF1A
${sample}`;
      if (!$("#fpPoolBox").hidden) {
        $("#fpPoolBox").hidden = true;
        await toggleFingerprintPool();
      }
      await loadFingerprintStatus();
    } catch (e) {
      $("#fpResult").textContent = "\u8FFD\u52A0\u5931\u8D25\uFF1A" + e.message;
    } finally {
      btn.disabled = false;
    }
  }
  async function clearExtraFingerprints() {
    if (!confirm("\u786E\u5B9A\u6E05\u7A7A\u5168\u90E8\u8FFD\u52A0\u6863\u6848\u3001\u6062\u590D\u57FA\u7840 12 \u5957\u8BBE\u5907\u6C60\uFF1F")) return;
    try {
      const r = await apiJson("/api/fingerprint/extra", { method: "DELETE" });
      $("#fpResult").textContent = `\u2705 \u5DF2\u6E05\u7A7A ${r.removed} \u5957\u8FFD\u52A0\u6863\u6848\uFF0C\u6062\u590D\u57FA\u7840\u6C60\uFF08\u73B0 ${r.poolSize} \u5957\uFF09\u3002`;
      if (!$("#fpPoolBox").hidden) {
        $("#fpPoolBox").hidden = true;
        await toggleFingerprintPool();
      }
      await loadFingerprintStatus();
    } catch (e) {
      $("#fpResult").textContent = "\u6E05\u7A7A\u5931\u8D25\uFF1A" + e.message;
    }
  }
  async function toggleFingerprintPool() {
    const box = $("#fpPoolBox");
    if (!box.hidden) {
      box.hidden = true;
      $("#fpPoolBtn").textContent = "\u67E5\u770B\u6307\u7EB9\u6C60\u660E\u7EC6";
      return;
    }
    try {
      const mode = $("#fpMode") ? $("#fpMode").value : "";
      const d = await apiJson(`/api/fingerprint/pool${mode ? `?mode=${encodeURIComponent(mode)}` : ""}`);
      const pool = d.pool || [];
      if (!pool.length) {
        box.innerHTML = '<p class="count" style="margin:0">\u5F53\u524D\u7AEF\u578B\u6A21\u5F0F\u4E0B\u5B50\u6C60\u4E3A\u7A7A\u3002</p>';
      } else {
        const rows = pool.map(
          (f, i) => `<tr>
          <td>${i + 1}</td><td><b>${esc(f.device)}</b></td>
          <td>${esc(f.platform)}</td><td>${f.viewport[0]}\xD7${f.viewport[1]}</td>
          <td>${f.mobile ? "\u79FB\u52A8" : "\u684C\u9762"}</td>
          <td>${f.brand ? `<span title="${esc(f.brand)}">${esc(f.brand.slice(0, 42))}\u2026</span>` : '<span class="muted">\u4E0D\u53D1\u9001</span>'}</td>
          <td><span title="${esc(f.ua)}">${esc(f.ua.slice(0, 58))}\u2026</span></td>
          <td style="max-width:150px;white-space:normal;font-size:11px">${esc((f.langs || []).join("<br>"))}</td>
        </tr>`
        ).join("");
        box.innerHTML = `<p class="count" style="margin:0 0 6px">${esc(FP_MODE_TEXT[d.mode] || d.mode || "")}\u5B50\u6C60\uFF08${pool.length} \u5957\uFF09\uFF1A\u91C7\u96C6\u65F6\u6BCF\u6B21\u8BF7\u6C42\u4ECE\u8BE5\u5B50\u6C60\u968F\u673A\u62BD\u53D6\u4E00\u5957\u5B8C\u6574\u6863\u6848\uFF1B\u7AEF\u578B\u8303\u56F4\u53EF\u5728\u4E0A\u65B9\u300C\u7AEF\u578B\u8303\u56F4\u300D\u5207\u6362\uFF08\u4FDD\u5B58\u5373\u751F\u6548\uFF09\u3002\u8BBE\u5907\u540D\u5E26\u300C\u8FFD\u52A0 \xB7\u300D\u524D\u7F00\u7684\u662F\u751F\u6210\u8FFD\u52A0\u7684\u6863\u6848\uFF0C\u5176\u4F59\u4E3A\u57FA\u7840\u771F\u5B9E\u8BBE\u5907\u6C60\uFF08\u7248\u672C\u968F\u4E3B\u6D41\u6D4F\u89C8\u5668\u4EBA\u5DE5\u66F4\u65B0\uFF09\u3002</p><table><thead><tr><th>#</th><th>\u8BBE\u5907\u6863\u6848</th><th>\u5E73\u53F0</th><th>\u89C6\u53E3</th><th>\u7AEF\u578B</th><th>Client Hints (sec-ch-ua)</th><th>User-Agent\uFF08\u60AC\u505C\u770B\u5168\u6587\uFF09</th><th>\u8BED\u8A00\u5019\u9009</th></tr></thead><tbody>${rows}</tbody></table>`;
      }
    } catch (e) {
      box.innerHTML = `<p style="color:#9a3412;font-size:12px">\u6307\u7EB9\u6C60\u52A0\u8F7D\u5931\u8D25\uFF1A${esc(e.message)}</p>`;
    }
    box.hidden = false;
    $("#fpPoolBtn").textContent = "\u6536\u8D77\u6307\u7EB9\u6C60\u660E\u7EC6";
  }
  async function changeFpMode() {
    const mode = $("#fpMode").value;
    try {
      await apiJson("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fpMode: mode })
      });
      $("#fpModeStatus").textContent = `\u7AEF\u578B\u8303\u56F4\u5DF2\u5207\u6362\u4E3A\u300C${FP_MODE_TEXT[mode]}\u300D\u5E76\u4FDD\u5B58\uFF0C\u5BF9\u540E\u7EED\u6BCF\u6B21\u6293\u53D6\u7ACB\u5373\u751F\u6548\u3002`;
      if (!$("#fpPoolBox").hidden) {
        $("#fpPoolBox").hidden = true;
        await toggleFingerprintPool();
      }
      await loadFingerprintStatus();
    } catch (e) {
      $("#fpResult").textContent = "\u7AEF\u578B\u8303\u56F4\u4FDD\u5B58\u5931\u8D25\uFF1A" + e.message;
    }
  }
  function fmtBytes(n) {
    if (!n && n !== 0) return "-";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
  }
  async function loadBackendInfo() {
    try {
      const b = await apiJson("/api/storage/backend");
      const label = b.backend === "mongodb" ? b.connected ? "MongoDB\uFF08\u5DF2\u8FDE\u63A5\uFF09" : "MongoDB\uFF08\u672A\u8FDE\u63A5\uFF09" : "SQLite\uFF08\u6587\u4EF6\u5E93\uFF09";
      $("#backendInfo").textContent = `\u5F53\u524D\u540E\u7AEF\uFF1A${label}`;
    } catch {
    }
  }
  var beTarget = null;
  function beLabel(name) {
    return name === "mongodb" ? "MongoDB" : "SQLite";
  }
  async function switchBackend(name) {
    try {
      const cur = await apiJson("/api/storage/backend");
      if (cur.backend === name) {
        alert(`\u5F53\u524D\u5DF2\u662F ${beLabel(name)} \u540E\u7AEF\uFF0C\u65E0\u9700\u5207\u6362\u3002`);
        return;
      }
    } catch {
    }
    beTarget = name;
    let fromLabel = beLabel(name) === "SQLite" ? "MongoDB" : "SQLite";
    try {
      const cur = await apiJson("/api/storage/backend");
      fromLabel = beLabel(cur.backend);
    } catch {
    }
    $("#beModalDir").innerHTML = `\u5207\u6362\u65B9\u5411\uFF1A<b>${esc(fromLabel)}</b> \u2192 <b>${esc(beLabel(name))}</b>`;
    $("#beModalInfo").textContent = "\u6B63\u5728\u6821\u9A8C\u76EE\u6807\u5E93\u8FDE\u901A\u6027\u4E0E\u6570\u636E\u7EDF\u8BA1\u2026";
    $("#beModalConfirm").disabled = true;
    $("#beModal").hidden = false;
    try {
      const pf = await apiJson(`/api/storage/preflight?backend=${encodeURIComponent(name)}`);
      if (!pf.ok) {
        $("#beModalInfo").innerHTML = `<p style="margin:0;color:#b91c1c">\u274C \u6821\u9A8C\u672A\u901A\u8FC7\uFF1A${esc(pf.error)}</p>`;
        return;
      }
      const fmt = (c) => `\u5546\u54C1 ${c.product || 0} \uFF5C \u8BC4\u8BBA ${c.review || 0} \uFF5C \u95EE\u7B54 ${c.qa || 0} \uFF5C \u804A\u5929 ${c.chat || 0}`;
      $("#beModalInfo").innerHTML = `<p style="margin:0 0 6px">\u2705 \u76EE\u6807\u5E93\u8FDE\u901A\u6027\u6821\u9A8C\u901A\u8FC7\u3002</p><p style="margin:0 0 6px"><b>\u6E90\uFF08${esc(pf.from)}\uFF09\u5F85\u8FC1\u79FB\uFF1A</b>${fmt(pf.sourceCounts)} \uFF5C \u5B9A\u65F6\u4EFB\u52A1 ${pf.sourceJobs} \u4E2A</p><p style="margin:0"><b>\u76EE\u6807\uFF08${esc(pf.to)}\uFF09\u73B0\u6709\uFF1A</b>${fmt(pf.targetCounts)} \uFF5C \u5B9A\u65F6\u4EFB\u52A1 ${pf.targetJobs} \u4E2A\uFF08\u76F8\u540C id \u5C06\u8986\u76D6\u66F4\u65B0\uFF0C\u5176\u4F59\u4FDD\u7559\uFF09</p>`;
      $("#beModalConfirm").disabled = false;
    } catch (e) {
      $("#beModalInfo").innerHTML = `<p style="margin:0;color:#b91c1c">\u274C \u9884\u68C0\u5931\u8D25\uFF1A${esc(e.message)}</p>`;
    }
  }
  async function confirmBackendSwitch() {
    if (!beTarget) return;
    $("#beModalConfirm").disabled = true;
    let started;
    try {
      started = await apiJson("/api/storage/backend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: beTarget, migrate: true })
      });
    } catch (e) {
      alert("\u542F\u52A8\u8FC1\u79FB\u5931\u8D25\uFF1A" + e.message);
      $("#beModalConfirm").disabled = false;
      return;
    }
    if (started.status !== "started") {
      alert(started.error || "\u542F\u52A8\u8FC1\u79FB\u5931\u8D25\u3002");
      $("#beModalConfirm").disabled = false;
      return;
    }
    $("#beModal").hidden = true;
    $("#beModalConfirm").disabled = false;
    const fill = $("#migFill");
    const text = $("#migText");
    $("#migBox").hidden = false;
    fill.className = "mig-fill";
    fill.style.width = "0%";
    text.textContent = "\u8FC1\u79FB\u4EFB\u52A1\u5DF2\u542F\u52A8\u2026";
    const timer = setInterval(async () => {
      let s;
      try {
        s = await apiJson("/api/storage/migration");
      } catch {
        return;
      }
      fill.style.width = `${s.pct || 0}%`;
      text.textContent = `\u23F3 ${s.phase || "\u8FC1\u79FB\u4E2D"}\uFF1A${s.done}/${s.total}\uFF08${s.pct || 0}%\uFF09`;
      if (s.running) return;
      clearInterval(timer);
      beTarget = null;
      if (s.error) {
        fill.className = "mig-fill fail";
        text.textContent = `\u274C \u8FC1\u79FB\u5931\u8D25\uFF1A${s.error}\uFF08\u540E\u7AEF\u672A\u5207\u6362\uFF0C\u539F\u6570\u636E\u4E0D\u53D7\u5F71\u54CD\uFF0C\u53EF\u4FEE\u590D\u540E\u91CD\u8BD5\uFF09`;
        alert(`\u274C \u6570\u636E\u8FC1\u79FB\u5931\u8D25\uFF1A${s.error}
\u540E\u7AEF\u4FDD\u6301\u4E0D\u53D8\uFF0C\u6E90\u6570\u636E\u4E0D\u53D7\u5F71\u54CD\uFF0C\u53EF\u4FEE\u590D\u540E\u91CD\u8BD5\u3002`);
        return;
      }
      fill.className = "mig-fill done";
      fill.style.width = "100%";
      const m = s.result?.migrated || {};
      const sum = `\u5546\u54C1 ${m.product || 0} \uFF5C \u8BC4\u8BBA ${m.review || 0} \uFF5C \u95EE\u7B54 ${m.qa || 0} \uFF5C \u804A\u5929 ${m.chat || 0} \uFF5C \u5B9A\u65F6\u4EFB\u52A1 ${m.jobs || 0}`;
      text.textContent = `\u2705 \u8FC1\u79FB\u5B8C\u6210\uFF08${sum}\uFF09\uFF0C\u5DF2\u5207\u6362\u5230 ${beLabel(s.result?.to)}\uFF0C\u7ACB\u5373\u751F\u6548\u3002`;
      alert(`\u2705 \u6570\u636E\u8FC1\u79FB\u5B8C\u6210\uFF01
${sum}
\u5DF2\u5207\u6362\u5230 ${beLabel(s.result?.to)} \u5E76\u7ACB\u5373\u751F\u6548\uFF08\u6E90\u5E93\u6570\u636E\u539F\u6837\u4FDD\u7559\uFF0C\u53EF\u968F\u65F6\u5207\u56DE\uFF09\u3002`);
      await Promise.all([loadBackendInfo(), loadStorage(), loadStats()]);
    }, 500);
  }
  async function loadStorage() {
    try {
      const s = await apiJson("/api/storage");
      const counts = s.counts || {};
      const lines = [
        `\u5B58\u50A8\u540E\u7AEF\uFF1A${s.backend === "mongodb" ? "MongoDB" : "SQLite"}`,
        s.backend === "mongodb" ? `\u8FDE\u63A5\u72B6\u6001\uFF1A${s.connected ? "\u5DF2\u8FDE\u63A5" : "\u672A\u8FDE\u63A5"} \uFF5C URI\uFF1A${s.mongoUri} \uFF5C \u5E93\uFF1A${s.dbName}` : `\u6570\u636E\u5E93\u6587\u4EF6\uFF1A${s.dbFile}\uFF08${fmtBytes(s.dbSize)}\uFF09`,
        `\u6570\u636E\u76EE\u5F55\uFF1A${s.dataDir}`,
        `\u5BFC\u51FA\u76EE\u5F55\uFF1A${s.exportsDir}\uFF08${s.exportFiles} \u4E2A\u6587\u4EF6\uFF0C${fmtBytes(s.exportsSize)}\uFF09`,
        `Cookie \u76EE\u5F55\uFF1A${s.cookiesDir}\uFF08${s.cookieFiles.length} \u4E2A\u6587\u4EF6\uFF09`,
        `\u4EE3\u7406\u6587\u4EF6\uFF1A${s.proxiesFile}${s.proxiesExists ? "" : "\uFF08\u4E0D\u5B58\u5728\uFF09"}`,
        `\u8BB0\u5F55\u6570\uFF1A\u5546\u54C1 ${counts.product || 0} \uFF5C \u8BC4\u8BBA ${counts.review || 0} \uFF5C \u95EE\u7B54 ${counts.qa || 0}`
      ];
      $("#storageInfo").textContent = lines.join("\n");
    } catch (e) {
      $("#storageInfo").textContent = "\u9519\u8BEF\uFF1A" + e.message;
    }
  }
  function clearScopeParams() {
    if ($("#clrScope").value === "filter") {
      return { platform: $("#dataPlatform").value || "", q: $("#dataSearch").value.trim() };
    }
    return { platform: "", q: "" };
  }
  function syncClearScopeInfo() {
    const { platform, q } = clearScopeParams();
    const info = $("#clrScopeInfo");
    if ($("#clrScope").value === "all") {
      info.textContent = "\u8303\u56F4\uFF1A\u5168\u90E8\u6570\u636E\uFF08\u5FFD\u7565\u7B5B\u9009\uFF09";
      return;
    }
    const parts = [];
    if (platform) parts.push(`\u5E73\u53F0=${platform}`);
    if (q) parts.push(`\u5173\u952E\u5B57="${q}"`);
    info.textContent = "\u8303\u56F4\uFF1A" + (parts.length ? parts.join(" \u4E14 ") : "\uFF08\u672A\u8BBE\u7B5B\u9009 = \u5168\u90E8\u6570\u636E\uFF09");
  }
  async function refreshClearCounts() {
    const box = $("#clrCounts");
    box.textContent = "\u7EDF\u8BA1\u4E2D\u2026";
    const { platform, q } = clearScopeParams();
    const qs = (type) => {
      const p = new URLSearchParams({ type, pageSize: "1" });
      if (platform) p.set("platform", platform);
      if (q) p.set("q", q);
      return `/api/data?${p}`;
    };
    try {
      const list = await Promise.all(
        [
          ["product", "\u5546\u54C1"],
          ["review", "\u8BC4\u8BBA"],
          ["qa", "\u95EE\u7B54"]
        ].map(async ([t, label]) => {
          try {
            const d = await apiJson(qs(t));
            return [t, label, d.total || 0];
          } catch {
            return [t, label, "?"];
          }
        })
      );
      box.innerHTML = `<table style="max-width:420px"><thead><tr><th>\u6570\u636E\u7C7B\u578B</th><th>\u8BE5\u8303\u56F4\u5185\u6761\u6570</th><th>\u662F\u5426\u5220\u9664</th></tr></thead><tbody>` + list.map(
        ([t, label, n]) => `<tr><td>${label}</td><td><b>${n}</b> \u6761</td><td><label class="check" style="display:flex"><input type="checkbox" data-clrtype="${t}" checked /> \u5220\u9664</label></td></tr>`
      ).join("") + `</tbody></table>`;
    } catch (e) {
      box.textContent = "\u7EDF\u8BA1\u5931\u8D25\uFF1A" + e.message;
    }
  }
  async function openClearModal() {
    $("#clrModalResult").textContent = "";
    syncClearScopeInfo();
    $("#clearModal").hidden = false;
    await refreshClearCounts();
  }
  async function confirmClear() {
    const types = [...$("#clrCounts").querySelectorAll("[data-clrtype]:checked")].map((c) => c.dataset.clrtype);
    const jobs = $("#clrJobs2").checked;
    const exports = $("#clrExports2").checked;
    const out = $("#clrModalResult");
    if (!types.length && !jobs && !exports) {
      out.textContent = "\u26A0 \u8BF7\u81F3\u5C11\u52FE\u9009\u4E00\u9879\u8981\u5220\u9664\u7684\u5185\u5BB9\u3002";
      return;
    }
    const { platform, q } = clearScopeParams();
    out.textContent = "\u6E05\u7A7A\u4E2D\u2026";
    try {
      const r = await apiJson("/api/storage/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, types, jobs, exports, platform, q })
      });
      const scope = platform || q ? "\uFF08\u6309\u5F53\u524D\u7B5B\u9009\u8303\u56F4\uFF09" : "\uFF08\u5168\u90E8\uFF09";
      out.textContent = `\u2705 \u5DF2\u6E05\u7A7A ${r.removed ?? r.count ?? 0} \u6761${scope}${r.exportsRemoved ? `\uFF0C\u5BFC\u51FA\u6587\u4EF6 ${r.exportsRemoved} \u4E2A` : ""}\u3002`;
      await Promise.all([loadStorage(), loadStats()]);
      pager.page = 1;
      renderTable(currentType);
      await refreshClearCounts();
    } catch (e) {
      out.textContent = "\u274C \u6E05\u7A7A\u5931\u8D25\uFF1A" + e.message;
    }
  }
  async function loadSettingsUi() {
    try {
      const s = await apiJson("/api/settings");
      $("#setDelayMin").value = s.delayMin;
      $("#setDelayMax").value = s.delayMax;
      $("#setTimeout").value = s.timeout;
      $("#setRetries").value = s.retries;
      $("#setRenderWait").value = s.renderWait;
      $("#setUsePw").checked = !!s.usePlaywright;
      $("#setRandFp").checked = !!s.randomizeFingerprint;
      $("#lgInterval").value = s.loginCheckMin ?? 30;
      if ($("#fpMode")) $("#fpMode").value = s.fpMode || "mixed";
      $("#settingsResult").textContent = `\u5F53\u524D\u8BBE\u7F6E\uFF1A\u5EF6\u8FDF ${s.delayMin}-${s.delayMax}ms \uFF5C \u8D85\u65F6 ${s.timeout}ms \uFF5C \u91CD\u8BD5 ${s.retries} \u6B21 \uFF5C \u6E32\u67D3\u7B49\u5F85 ${s.renderWait}ms \uFF5C Playwright:${s.usePlaywright ? "\u5F00" : "\u5173"} \uFF5C \u6307\u7EB9\u968F\u673A\u5316:${s.randomizeFingerprint ? "\u5F00" : "\u5173"} \uFF5C \u5B58\u50A8\u540E\u7AEF:${s.storageBackend}`;
    } catch (e) {
      $("#settingsResult").textContent = "\u9519\u8BEF\uFF1A" + e.message;
    }
  }
  async function saveSettingsUi() {
    const btn = $("#saveSettings");
    const body = {
      delayMin: $("#setDelayMin").value,
      delayMax: $("#setDelayMax").value,
      timeout: $("#setTimeout").value,
      retries: $("#setRetries").value,
      renderWait: $("#setRenderWait").value,
      usePlaywright: $("#setUsePw").checked,
      randomizeFingerprint: $("#setRandFp").checked,
      fpMode: $("#fpMode") ? $("#fpMode").value : void 0
    };
    try {
      btn.disabled = true;
      $("#settingsResult").textContent = "\u4FDD\u5B58\u4E2D\u2026";
      await apiJson("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      await loadSettingsUi();
      const el = $("#settingsResult");
      el.textContent = `\u2705 \u5DF2\u4FDD\u5B58 ${(/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false })} \uFF5C ${el.textContent}`;
    } catch (e) {
      $("#settingsResult").textContent = "\u4FDD\u5B58\u5931\u8D25\uFF1A" + e.message;
    } finally {
      btn.disabled = false;
    }
  }
  function renderDgResult(r) {
    const head = [
      `\u8BCA\u65AD\u5BF9\u8C61\uFF1A${r.source}`,
      `\u9875\u9762\u5927\u5C0F\uFF1A${(r.htmlSize / 1024).toFixed(0)} KB`,
      `CSS \u9009\u62E9\u5668\u5361\u7247\u5757\uFF1A${r.selectorBlocks} \u4E2A\uFF08\u5176\u4E2D\u53EF\u62BD\u51FA\u5B57\u6BB5 ${r.usableBlocks} \u4E2A\uFF09`,
      `JSON-LD \u7ED3\u6784\u5316\u6570\u636E\uFF1A${r.jsonLd} \u6761`,
      `\u5F53\u524D\u53EF\u7528\u7B56\u7565\uFF1A${r.strategy}`,
      `\u5EFA\u8BAE\uFF1A${r.advice}`
    ].join("\n");
    const fieldRows = (r.fields || []).map(
      (f) => `<tr><td>${esc(f.field)}</td><td><code>${esc(f.selector)}</code></td><td>${f.matched}</td><td>${esc(
        (f.sample || []).join(" \uFF5C ").slice(0, 120) || "\u2014"
      )}</td></tr>`
    ).join("");
    const sampleRows = (r.sample || []).map((s) => `<pre style="margin:4px 0">${esc(JSON.stringify(s, null, 1))}</pre>`).join("");
    $("#dgResult").innerHTML = `<p class="count" style="white-space:pre-wrap">${esc(head)}</p><table><thead><tr><th>\u5B57\u6BB5</th><th>\u9009\u62E9\u5668\u5199\u6CD5</th><th>\u547D\u4E2D</th><th>\u6837\u4F8B\u503C</th></tr></thead><tbody>${fieldRows}</tbody></table>` + (sampleRows ? `<p class="count">\u7EC4\u5408\u6837\u4F8B\uFF08\u6309\u5F53\u524D\u9009\u62E9\u5668\u5B9E\u9645\u4F1A\u5165\u5E93\u7684\u8BB0\u5F55\uFF09\uFF1A</p>${sampleRows}` : "");
  }
  async function diagnoseApi(body) {
    const platform = $("#platform").value;
    if (!platform) {
      $("#dgResult").textContent = "\u8BF7\u5148\u5728\u300C\u91C7\u96C6\u5DE5\u4F5C\u53F0\u300D\u4E0A\u65B9\u5171\u7528\u5E73\u53F0\u9009\u62E9\u91CC\u6311\u4E00\u4E2A\u5177\u4F53\u5E73\u53F0\uFF08\u8BCA\u65AD\u9700\u8981\u5E73\u53F0\u5BF9\u5E94\u7684\u9009\u62E9\u5668\u914D\u7F6E\uFF09\u3002";
      return;
    }
    $("#dgResult").textContent = "\u8BCA\u65AD\u4E2D\u2026\uFF08\u89E3\u6790 HTML\uFF0C\u9010\u5B57\u6BB5\u6838\u5BF9\u9009\u62E9\u5668\u547D\u4E2D\uFF09";
    try {
      const r = await apiJson("/api/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, kind: $("#dgKind").value, ...body })
      });
      if (!r.ok) {
        $("#dgResult").textContent = "\u8BCA\u65AD\u5931\u8D25\uFF1A" + (r.reason || r.error || "\u672A\u77E5\u539F\u56E0");
        return;
      }
      renderDgResult(r);
    } catch (e) {
      $("#dgResult").textContent = "\u9519\u8BEF\uFF1A" + e.message;
    }
  }
  function dgFileSelected() {
    const f = $("#dgFile").files[0];
    $("#dgFileName").textContent = f ? `${f.name}\uFF08${(f.size / 1024).toFixed(0)} KB\uFF09` : "\u672A\u9009\u62E9\u6587\u4EF6";
    $("#dgBtn").disabled = !f;
  }
  async function runDiagnoseFile() {
    const f = $("#dgFile").files[0];
    if (!f) {
      $("#dgResult").textContent = "\u8BF7\u5148\u70B9\u300C\u2460 \u9009\u62E9 HTML \u6587\u4EF6\u300D\u9009\u4E2D\u4E00\u4E2A .html \u6587\u4EF6\u3002";
      return;
    }
    const html = await f.text();
    await diagnoseApi({ htmlContent: html, url: f.name });
  }
  async function runDiagnosePath() {
    const src = $("#dgSource").value.trim();
    if (!src) {
      $("#dgResult").textContent = "\u8BF7\u586B\u5199\u670D\u52A1\u5668\u53EF\u8BBF\u95EE\u7684 HTML \u6587\u4EF6\u8DEF\u5F84\uFF08\u5982\u628A\u6587\u4EF6\u653E\u8FDB\u9879\u76EE data/ \u76EE\u5F55\u540E\u586B data/xxx.html\uFF09\u3002";
      return;
    }
    await diagnoseApi({ fixturePath: src });
  }
  var pager = { page: 1, pageSize: 20, total: 0 };
  function cell(v, max = 40) {
    const s = String(v ?? "");
    if (!s) return '<span class="muted">\u2014</span>';
    const shown = s.length > max ? s.slice(0, max) + "\u2026" : s;
    return `<span title="${esc(s)}">${esc(shown)}</span>`;
  }
  function linkCell(url) {
    if (!url) return '<span class="muted">\u2014</span>';
    const href = url.startsWith("//") ? "https:" + url : url;
    if (!/^https?:\/\//.test(href)) return cell(url, 24);
    return `<a href="${esc(href)}" target="_blank" rel="noopener">\u6253\u5F00</a>`;
  }
  function fmtTime(iso) {
    if (!iso) return "\u2014";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return esc(String(iso).slice(0, 16));
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function timeCell(iso) {
    return esc(fmtTime(iso));
  }
  var renderSeq = 0;
  function renderTable(type, keepPage = false) {
    currentType = type;
    if (!keepPage) pager.page = 1;
    const seq = ++renderSeq;
    const q = new URLSearchParams({ type, page: String(pager.page), pageSize: String(pager.pageSize) });
    const plat = $("#dataPlatform") ? $("#dataPlatform").value : "";
    const kw = $("#dataSearch") ? $("#dataSearch").value.trim() : "";
    if (plat) q.set("platform", plat);
    if (kw) q.set("q", kw);
    apiJson(`/api/data?${q}`).then((d) => {
      if (seq !== renderSeq) return;
      pager.total = d.total || 0;
      const rows = d.rows || [];
      const totalPages = Math.max(1, Math.ceil(pager.total / pager.pageSize));
      let html = "";
      if (type === "product") {
        html = `<table><thead><tr><th>#</th><th>\u5E73\u53F0</th><th>\u6807\u9898</th><th>\u4EF7\u683C</th><th>\u7C7B\u76EE</th><th>\u54C1\u724C</th><th>\u9500\u91CF</th><th>\u5E97\u94FA</th><th>ItemId</th><th>\u94FE\u63A5</th><th>\u91C7\u96C6\u65F6\u95F4</th><th>\u64CD\u4F5C</th></tr></thead><tbody>
        ${rows.map(
          (r, i) => `<tr><td>${(pager.page - 1) * pager.pageSize + i + 1}</td><td>${esc(r.platform)}</td><td>${cell(r.title, 46)}</td><td>\xA5${r.price}</td><td>${cell(r.category, 14)}</td><td>${cell(r.brand, 12)}</td><td>${r.sales > 0 ? r.sales : '<span class="muted">\u2014</span>'}</td><td>${cell(r.shopName, 16)}</td><td>${cell(r.itemId, 14)}</td><td>${linkCell(r.url)}</td><td>${timeCell(r.collectedAt)}</td><td><button data-detail="${i}" style="padding:2px 10px">\u8BE6\u60C5</button></td></tr>`
        ).join("")}</tbody></table>`;
        drawerRows = rows;
      } else if (type === "review") {
        html = `<table><thead><tr><th>#</th><th>\u5E73\u53F0</th><th>\u5546\u54C1</th><th>\u8BC4\u5206</th><th>\u5185\u5BB9</th><th>\u4F5C\u8005</th><th>\u6807\u7B7E</th><th>\u8BC4\u4EF7\u65F6\u95F4</th><th>\u91C7\u96C6\u65F6\u95F4</th></tr></thead><tbody>
        ${rows.map(
          (r, i) => `<tr><td>${(pager.page - 1) * pager.pageSize + i + 1}</td><td>${esc(r.platform)}</td><td><button class="btn-ghost" data-jumpprod="${esc(r.itemId || "")}" data-plat="${esc(r.platform)}" style="padding:1px 6px;font-size:12px" ${r.itemId ? "" : "disabled"} title="\u70B9\u51FB\u67E5\u770B\u8BE5\u5546\u54C1">${esc(String(r.productTitle || "\u2014").slice(0, 24))}</button></td><td>${r.rating}\u2605</td><td>${cell(r.content, 60)}</td><td>${esc(r.authorMasked)}</td><td>${cell((r.tags || []).join(","), 10)}</td><td>${timeCell(r.createdAt)}</td><td>${timeCell(r.collectedAt)}</td></tr>`
        ).join("")}</tbody></table>`;
      } else if (type === "qa") {
        html = `<table><thead><tr><th>#</th><th>\u5E73\u53F0</th><th>\u5546\u54C1</th><th>\u95EE\u9898</th><th>\u56DE\u7B54</th><th>\u63D0\u95EE\u4EBA</th><th>\u65F6\u95F4</th></tr></thead><tbody>
        ${rows.map(
          (r, i) => `<tr><td>${(pager.page - 1) * pager.pageSize + i + 1}</td><td>${esc(r.platform)}</td><td><button class="btn-ghost" data-jumpprod="${esc(r.itemId || "")}" data-plat="${esc(r.platform)}" style="padding:1px 6px;font-size:12px" ${r.itemId ? "" : "disabled"}>${esc(String(r.productTitle || "\u2014").slice(0, 24))}</button></td><td>${cell(r.question, 40)}</td><td>${cell(r.answer, 40)}</td><td>${esc(r.askerMasked)}</td><td>${timeCell(r.createdAt)}</td></tr>`
        ).join("")}</tbody></table>`;
      } else {
        html = "";
      }
      $("#tableWrap").innerHTML = (rows.length ? "" : "<p>\u6682\u65E0\u6570\u636E</p>") + html;
      $("#pgInfo").textContent = `\u5171 ${pager.total} \u6761 \uFF5C \u7B2C ${pager.page} / ${totalPages} \u9875`;
      $("#pgPrev").disabled = pager.page <= 1;
      $("#pgNext").disabled = pager.page >= totalPages;
      if (type === "product") {
        $("#tableWrap").querySelectorAll("[data-detail]").forEach(
          (b) => b.addEventListener("click", () => openDrawer(drawerRows[Number(b.dataset.detail)]))
        );
      } else {
        $("#tableWrap").querySelectorAll("[data-jumpprod]").forEach(
          (b) => b.addEventListener("click", () => jumpToProduct(b.dataset.plat, b.dataset.jumpprod))
        );
      }
    }).catch((e) => {
      if (seq !== renderSeq) return;
      $("#tableWrap").innerHTML = `<p style="color:#9a3412">\u6570\u636E\u52A0\u8F7D\u5931\u8D25\uFF1A${esc(e.message)}</p>`;
    });
  }
  function jumpToProduct(platform, itemId) {
    if (!itemId) return;
    document.querySelectorAll(".tab").forEach((x) => {
      x.classList.toggle("active", x.dataset.type === "product");
    });
    $("#dataPlatform").value = [...$("#dataPlatform").options].some((o) => o.value === platform) ? platform : "";
    $("#dataSearch").value = itemId;
    renderTable("product");
  }
  var drawerRows = [];
  var drawerOpen = false;
  function renderSpecs(specs) {
    if (!specs || typeof specs !== "object") return "";
    const spu = specs.spu || {};
    const skus = specs.skus || [];
    const label = { marketPrice: "\u5E02\u573A\u4EF7", discount: "\u4FC3\u9500", skuCode: "SKU\u7F16\u7801", skuCount: "SKU\u6570", tags: "\u6807\u7B7E", inStock: "\u6709\u8D27", goodRate: "\u597D\u8BC4\u7387", currency: "\u5E01\u79CD", stock: "\u5E93\u5B58", color: "\u989C\u8272", version: "\u7248\u672C" };
    const propTable = specs.props && typeof specs.props === "object" ? Object.entries(specs.props) : null;
    const extra = Object.entries(specs).filter(
      ([k]) => !["spu", "skus", "propGroups", "props"].includes(k) && specs[k] !== "" && specs[k] != null
    );
    let html = "<h4>SPU \u5546\u54C1\u4FE1\u606F</h4>";
    const spuFields = [
      ["\u6807\u9898", spu.title],
      ["\u54C1\u724C", spu.brandName || spu.brand],
      ["\u5E97\u94FA", spu.shopName || spu.vendorName],
      ["\u7C7B\u76EE", spu.categoryName],
      ["\u4EF7\u683C", spu.price ? "\xA5" + spu.price : ""],
      ["SPU", spu.spuId || spu.prodSpuId]
    ].filter(([, v]) => v !== void 0 && v !== null && v !== "");
    if (spuFields.length) {
      html += `<table><tbody>${spuFields.map(([k, v]) => `<tr><th style="width:70px">${esc(k)}</th><td>${cell(v, 60)}</td></tr>`).join("")}</tbody></table>`;
    } else {
      html += '<p class="muted" style="font-size:12px;margin:0">\u65E0\u7ED3\u6784\u5316 SPU \u5B57\u6BB5\uFF08\u5E26\u8BE6\u60C5\u91C7\u96C6\u540E\u4F1A\u51FA\u73B0\uFF09</p>';
    }
    if (extra.length) {
      html += `<h4>\u5546\u54C1\u9644\u52A0\u5B57\u6BB5</h4><table><tbody>${extra.map(([k, v]) => `<tr><th style="width:70px">${esc(label[k] || k)}</th><td>${cell(typeof v === "object" ? JSON.stringify(v) : v, 60)}</td></tr>`).join("")}</tbody></table>`;
    }
    if (propTable && propTable.length) {
      html += `<h4>\u89C4\u683C\u53C2\u6570\uFF08${propTable.length} \u9879\uFF09</h4><table><tbody>` + propTable.map(([k, v]) => `<tr><th style="width:110px">${esc(k)}</th><td>${cell(String(v), 80)}</td></tr>`).join("") + `</tbody></table>`;
    }
    html += `<h4>SKU \u660E\u7EC6\uFF08${skus.length} \u6761\uFF09</h4>`;
    if (skus.length) {
      html += `<table><thead><tr><th>#</th><th>SKU</th><th>\u89C4\u683C</th><th>\u4EF7\u683C</th><th>\u72B6\u6001</th></tr></thead><tbody>` + skus.slice(0, 60).map((s, i) => {
        const name = s.name || s.skuName || s.title || s.skuId || `#${i + 1}`;
        const props = [s.props, s.spec, s.value, s.color, s.version].filter(Boolean).join(" / ");
        const price = s.price != null && s.price !== "" && Number(s.price) > 0 ? "\xA5" + s.price : "\u2014";
        const status = s.stock === false || s.offline ? "\u4E0B\u67B6" : s.stock === true ? "\u6709\u8D27" : s.status || "\u2014";
        return `<tr><td>${i + 1}</td><td>${cell(s.skuId || "", 14)}</td><td>${esc(String(name)).slice(0, 40)}${props ? `<span class="muted" style="font-size:11px"> ${esc(String(props)).slice(0, 40)}</span>` : ""}</td><td>${price}</td><td>${esc(String(status)).slice(0, 12)}</td></tr>`;
      }).join("") + `</tbody></table>${skus.length > 60 ? `<p class="hint">\u4EC5\u5C55\u793A\u524D 60 \u6761\uFF0C\u5B8C\u6574\u6570\u636E\u89C1\u4E0B\u65B9 JSON\u3002</p>` : ""}`;
    } else {
      html += '<p class="muted" style="font-size:12px;margin:0">\u8BE5\u8BB0\u5F55\u65E0 SKU \u660E\u7EC6\uFF08\u53EF\u80FD\u672A\u5F00\u542F\u5E26\u8BE6\u60C5\u91C7\u96C6\uFF09</p>';
    }
    return html;
  }
  async function loadRelatedItems(p) {
    const box = $("#drawerRelated");
    if (!box) return;
    if (!p.itemId) {
      box.innerHTML = '<h4>\u5173\u8054\u8BC4\u8BBA / \u95EE\u7B54</h4><p class="muted" style="font-size:12px;margin:0">\u8BE5\u8BB0\u5F55\u65E0 itemId\uFF0C\u65E0\u6CD5\u5173\u8054</p>';
      return;
    }
    box.innerHTML = '<h4>\u5173\u8054\u8BC4\u8BBA / \u95EE\u7B54</h4><p class="muted" style="font-size:12px;margin:0">\u68C0\u7D22\u4E2D\u2026</p>';
    try {
      const [rv, qa] = await Promise.all([
        apiJson(`/api/data?type=review&platform=${encodeURIComponent(p.platform)}&q=${encodeURIComponent(p.itemId)}&pageSize=50`),
        apiJson(`/api/data?type=qa&platform=${encodeURIComponent(p.platform)}&q=${encodeURIComponent(p.itemId)}&pageSize=50`)
      ]);
      const rvRows = (rv.rows || []).filter((r) => r.itemId === p.itemId);
      const qaRows = (qa.rows || []).filter((r) => r.itemId === p.itemId);
      let html = `<h4>\u5173\u8054\u8BC4\u8BBA\uFF08${rvRows.length}\uFF09/ \u95EE\u7B54\uFF08${qaRows.length}\uFF09</h4>`;
      if (!rvRows.length && !qaRows.length) {
        html += `<p class="muted" style="font-size:12px;margin:0">\u8BE5\u5546\u54C1\u6682\u65E0\u5173\u8054\u8BC4\u8BBA/\u95EE\u7B54\u3002\u53EF\u52FE\u9009\u300C\u5E26\u8BE6\u60C5\u300D\u91C7\u96C6\uFF0C\u6216\u5728\u4E0A\u65B9\u70B9\u300C\u8865\u6293\u8BE6\u60C5\u300D\u4E00\u5E76\u5217\u51FA\u3002</p>`;
      } else {
        if (rvRows.length) {
          html += `<table><thead><tr><th>\u8BC4\u5206</th><th>\u5185\u5BB9</th><th>\u4F5C\u8005</th><th>\u65F6\u95F4</th></tr></thead><tbody>${rvRows.slice(0, 6).map((r) => `<tr><td>${r.rating}\u2605</td><td>${cell(r.content, 50)}</td><td>${esc(r.authorMasked || "")}</td><td>${timeCell(r.createdAt || r.collectedAt)}</td></tr>`).join("")}</tbody></table>`;
        }
        if (qaRows.length) {
          html += `<table style="margin-top:8px"><thead><tr><th>\u95EE\u9898</th><th>\u56DE\u7B54</th></tr></thead><tbody>${qaRows.slice(0, 6).map((q) => `<tr><td>${cell(q.question, 40)}</td><td>${cell(q.answer, 40)}</td></tr>`).join("")}</tbody></table>`;
        }
      }
      box.innerHTML = html;
    } catch (e) {
      box.innerHTML = `<h4>\u5173\u8054\u8BC4\u8BBA / \u95EE\u7B54</h4><p style="color:#9a3412;font-size:12px">\u68C0\u7D22\u5931\u8D25\uFF1A${esc(e.message)}</p>`;
    }
  }
  async function refetchDetail(p) {
    const btn = $("#refetchBtn");
    const box = $("#refetchResult");
    btn.disabled = true;
    box.textContent = "\u8865\u6293\u4E2D\u2026\uFF08\u5BF9\u8BE5\u5546\u54C1\u53D1\u4E00\u6B21\u771F\u5B9E\u8BE6\u60C5\u8BF7\u6C42\uFF0C\u7EA6\u9700 5~60 \u79D2\uFF09";
    try {
      const r = await apiJson("/api/detail-refetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id })
      });
      if (r.status === "empty") {
        box.textContent = "\u26A0 " + (r.message || "\u8BE6\u60C5\u9875\u672A\u66B4\u9732 SPU/SKU \u6570\u636E");
      } else {
        box.textContent = "\u2705 " + (r.message || "\u5DF2\u66F4\u65B0");
        const d = await apiJson(`/api/data?type=product&platform=${encodeURIComponent(p.platform)}&q=${encodeURIComponent(p.itemId || p.title)}&pageSize=20`);
        const fresh = (d.rows || []).find((x) => x.id === p.id);
        if (fresh) openDrawer(fresh);
      }
    } catch (e) {
      box.textContent = "\u274C " + e.message;
    } finally {
      btn.disabled = false;
    }
  }
  function openDrawer(p) {
    if (!p) return;
    drawerOpen = true;
    $("#drawerTitle").textContent = p.title || `itemId=${p.itemId}`;
    const specs = typeof p.specs === "string" ? (() => {
      try {
        return JSON.parse(p.specs);
      } catch {
        return null;
      }
    })() : p.specs;
    const meta = [
      ["\u5E73\u53F0", p.platform],
      ["\u4EF7\u683C", p.price != null ? "\xA5" + p.price : "\u2014"],
      ["\u54C1\u724C", p.brand || "\u2014"],
      ["\u5E97\u94FA", p.shopName || "\u2014"],
      ["\u7C7B\u76EE", p.category || "\u2014"],
      ["\u9500\u91CF", p.sales > 0 ? p.sales : "\u2014"],
      ["ItemId", p.itemId],
      ["\u91C7\u96C6\u65F6\u95F4", fmtTime(p.collectedAt)]
    ];
    const hasDetail = !!(specs && (specs.spu || (specs.skus || []).length || specs.props));
    const imgs = Array.isArray(p.images) ? p.images : typeof p.images === "string" ? (() => {
      try {
        return JSON.parse(p.images);
      } catch {
        return [];
      }
    })() : [];
    const absImg = (u) => typeof u === "string" && u ? u.startsWith("//") ? "https:" + u : u : "";
    $("#drawerBody").innerHTML = `<table><tbody>${meta.map(([k, v]) => `<tr><th style="width:76px">${esc(k)}</th><td>${esc(String(v ?? ""))}</td></tr>`).join("")}</tbody></table>` + (p.url ? `<h4>\u5546\u54C1\u94FE\u63A5</h4><p style="margin:0;font-size:13px"><a href="${esc(p.url.startsWith("//") ? "https:" + p.url : p.url)}" target="_blank" rel="noopener">${esc(p.url).slice(0, 90)}</a></p>` : "") + (imgs.length ? `<h4>\u5546\u54C1\u56FE\u7247\uFF08${imgs.length}\uFF09</h4><div class="drawer-imgs">${imgs.slice(0, 12).map((u) => {
      const a = absImg(u);
      return a ? `<a href="${esc(a)}" target="_blank" rel="noopener" title="\u70B9\u51FB\u67E5\u770B\u539F\u56FE"><img src="${esc(a)}" loading="lazy" referrerpolicy="no-referrer" alt=""/></a>` : "";
    }).join("")}${imgs.length > 12 ? `<span class="hint" style="align-self:center">\u5171 ${imgs.length} \u5F20\uFF0C\u5176\u4F59\u89C1 JSON</span>` : ""}</div>` : "") + (p.description ? `<h4>\u5546\u54C1\u63CF\u8FF0</h4><p class="drawer-desc" title="\u70B9\u51FB\u590D\u5236\u5168\u6587" data-desc="${esc(p.description)}">${esc(p.description.slice(0, 600))}${p.description.length > 600 ? `\u2026\uFF08\u5171 ${p.description.length} \u5B57\uFF0C\u70B9\u51FB\u590D\u5236\u5168\u6587\uFF09` : ""}</p>` : "") + renderSpecs(specs) + `<div class="controls" style="margin:12px 0 4px;padding-top:10px;border-top:1px dashed var(--line)">
      <button id="refetchBtn" class="btn-ghost">\u{1F504} \u8865\u6293\u8BE6\u60C5\uFF08\u63CF\u8FF0/\u56FE\u7247/SPU/SKU\uFF09</button>
      <span id="refetchResult" class="hint" style="flex:1">${hasDetail ? "\u5DF2\u6709\u8BE6\u60C5\u6570\u636E\uFF0C\u53EF\u91CD\u65B0\u8865\u6293\u5237\u65B0\u3002" : "\u8BE5\u5546\u54C1\u7F3A\u8BE6\u60C5\u6570\u636E\uFF0C\u70B9\u6309\u94AE\u8865\u6293\uFF08\u9700\u771F\u5B9E\u8BBF\u95EE\u8BE6\u60C5\u9875\uFF09\u3002"}</span>
    </div><div id="drawerRelated"></div><h4>\u5B8C\u6574\u8BB0\u5F55\uFF08JSON\uFF09</h4><pre class="drawer-json">${esc(JSON.stringify(p, null, 2))}</pre>`;
    $("#drawerMask").hidden = false;
    $("#refetchBtn").addEventListener("click", () => refetchDetail(p));
    const descEl = $("#drawerBody .drawer-desc");
    if (descEl) {
      descEl.addEventListener("click", () => {
        navigator.clipboard.writeText(descEl.dataset.desc || "").then(() => {
          descEl.style.color = "var(--ok, #166534)";
          setTimeout(() => descEl.style.color = "", 1200);
        });
      });
    }
    loadRelatedItems(p);
  }
  function closeDrawer() {
    drawerOpen = false;
    $("#drawerMask").hidden = true;
  }
  function bindPager() {
    $("#pgPrev").addEventListener("click", () => {
      if (pager.page > 1) {
        pager.page--;
        renderTable(currentType, true);
      }
    });
    $("#pgNext").addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(pager.total / pager.pageSize));
      if (pager.page < totalPages) {
        pager.page++;
        renderTable(currentType, true);
      }
    });
    $("#pageSize").addEventListener("change", () => {
      pager.pageSize = Number($("#pageSize").value);
      renderTable(currentType, true);
    });
    $("#pgGo").addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(pager.total / pager.pageSize));
      const n = Math.min(totalPages, Math.max(1, Number($("#pgJump").value) || 1));
      pager.page = n;
      renderTable(currentType, true);
    });
  }
  function downloadExport(format) {
    const a = document.createElement("a");
    const plat = $("#dataPlatform").value;
    const kw = $("#dataSearch").value.trim();
    let url = `/api/export?type=${currentType}&format=${format}`;
    if (plat) url += `&platform=${encodeURIComponent(plat)}`;
    if (kw) url += `&q=${encodeURIComponent(kw)}`;
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  $("#runBtn").addEventListener("click", runCollect);
  $("#stopBtn").addEventListener("click", stopCollect);
  $("#saveAsJob").addEventListener("click", saveAsJob);
  $("#ckCopy").addEventListener("click", copyCookiesJson);
  $("#ckModalClose").addEventListener("click", () => $("#cookieModal").hidden = true);
  $("#cookieModal").addEventListener("click", (e) => {
    if (e.target === $("#cookieModal")) $("#cookieModal").hidden = true;
  });
  $("#addJobBtn").addEventListener("click", addJob);
  $("#jobType").addEventListener("change", syncJobDetailLimitUi);
  $("#jobDetails").addEventListener("change", syncJobDetailLimitUi);
  syncJobDetailLimitUi();
  $("#proxyReload").addEventListener(
    "click",
    () => api("/api/proxy/reload", { method: "POST" }).then(() => loadProxy()).catch(() => {
    })
  );
  $("#expCsv").addEventListener("click", () => downloadExport("csv"));
  $("#expJson").addEventListener("click", () => downloadExport("json"));
  $("#fpAppend").addEventListener("click", appendFingerprints);
  $("#fpClear").addEventListener("click", clearExtraFingerprints);
  $("#fpPoolBtn").addEventListener("click", toggleFingerprintPool);
  $("#fpMode").addEventListener("change", changeFpMode);
  $("#dataClearBtn").addEventListener("click", openClearModal);
  $("#clearModalClose").addEventListener("click", () => $("#clearModal").hidden = true);
  $("#clearModal").addEventListener("click", (e) => {
    if (e.target === $("#clearModal")) $("#clearModal").hidden = true;
  });
  $("#clrScope").addEventListener("change", () => {
    syncClearScopeInfo();
    refreshClearCounts();
  });
  $("#clrConfirm").addEventListener("click", confirmClear);
  $("#saveSettings").addEventListener("click", saveSettingsUi);
  $("#dgFileBtn").addEventListener("click", () => $("#dgFile").click());
  $("#dgFile").addEventListener("change", dgFileSelected);
  $("#dgBtn").addEventListener("click", runDiagnoseFile);
  $("#dgPathBtn").addEventListener("click", runDiagnosePath);
  $("#beSqlite").addEventListener("click", () => switchBackend("sqlite"));
  $("#beMongo").addEventListener("click", () => switchBackend("mongodb"));
  $("#beModalConfirm").addEventListener("click", confirmBackendSwitch);
  $("#beModalClose").addEventListener("click", () => $("#beModal").hidden = true);
  $("#beModalCancel").addEventListener("click", () => $("#beModal").hidden = true);
  $("#beModal").addEventListener("click", (e) => {
    if (e.target === $("#beModal")) $("#beModal").hidden = true;
  });
  $("#proxyAdd").addEventListener("click", addProxyUi);
  $("#proxyTest").addEventListener("click", testProxiesUi);
  $("#testBtn").addEventListener("click", runTestUi);
  $("#testModalRerun").addEventListener("click", runTestUi);
  $("#testModalClose").addEventListener("click", () => $("#testModal").hidden = true);
  $("#testModal").addEventListener("click", (e) => {
    if (e.target === $("#testModal") && !testRunning) $("#testModal").hidden = true;
  });
  $("#lgSaveInterval").addEventListener("click", saveLoginInterval);
  $("#lgCheckAll").addEventListener("click", checkAllLoginUi);
  $("#lgSaveCookie").addEventListener("click", saveLoginCookie);
  document.querySelectorAll(".tab").forEach(
    (t) => t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      renderTable(t.dataset.type);
    })
  );
  document.querySelectorAll(".nav-item").forEach(
    (n) => n.addEventListener("click", () => showPage(n.dataset.page))
  );
  window.addEventListener("hashchange", () => showPage((location.hash || "").replace("#/", "")));
  $("#platform").addEventListener("change", () => {
    updatePlatCard();
  });
  $("#dataType").addEventListener("change", syncDataTypeUi);
  $("#withDetails").addEventListener("change", syncDetailLimitUi);
  $("#dataPlatform").addEventListener("change", () => renderTable(currentType));
  $("#dataSearchBtn").addEventListener("click", () => renderTable(currentType));
  $("#dataReset").addEventListener("click", () => {
    $("#dataPlatform").value = "";
    $("#dataSearch").value = "";
    renderTable(currentType);
  });
  $("#dataSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") renderTable(currentType);
  });
  var searchTimer = null;
  $("#dataSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderTable(currentType, true), 400);
  });
  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#drawerMask").addEventListener("click", (e) => {
    if (e.target === $("#drawerMask")) closeDrawer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawerOpen) closeDrawer();
    if (e.key === "Escape" && !testRunning) $("#testModal").hidden = true;
    if (e.key === "Escape") $("#clearModal").hidden = true;
    if (e.key === "Escape") $("#beModal").hidden = true;
  });
  syncDataTypeUi();
  loadPlatforms().then(() => {
    showPage((location.hash || "").replace("#/", ""));
    return updatePlatCard();
  }).then(loadStats).then(() => {
    renderTable("product");
    bindPager();
    loadJobs();
    loadRuns();
    loadProxy();
    loadFingerprintStatus();
    loadStorage();
    loadBackendInfo();
    loadSettingsUi();
    loadLoginStatus();
    setInterval(pollStats, 5e3);
    pollStats();
  });
})();
