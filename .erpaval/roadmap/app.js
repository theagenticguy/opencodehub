/* OpenCodeHub Roadmap SPA — jQuery renderer + interactions */

(function ($) {
  "use strict";

  var DATA = window.RoadmapData;
  var state = {
    view: "overview",
    filters: { surface: "all", tier: "all", search: "" },
    selectedId: null
  };

  // ─── Bootstrapping ───────────────────────────────────────
  $(function () {
    renderOverview();
    renderTimeline();
    renderBoard();
    renderPillars();
    renderDeps();
    bindEvents();
    applyFilters();
    updateCounter();
    // Deep link support
    if (window.location.hash) {
      var id = window.location.hash.replace("#", "");
      setTimeout(function () { openDrawer(id); }, 60);
    }
  });

  // ─── Event bindings ──────────────────────────────────────
  function bindEvents() {
    $(".view-btn").on("click", function () {
      var v = $(this).data("view");
      state.view = v;
      $(".view-btn").removeClass("is-active").attr("aria-selected", "false");
      $(this).addClass("is-active").attr("aria-selected", "true");
      $(".view").removeClass("is-active");
      $(".view[data-view='" + v + "']").addClass("is-active");
      // Dependency view needs positions re-computed after display
      if (v === "deps") setTimeout(layoutDeps, 30);
    });

    $(".chip").on("click", function () {
      var filter = $(this).data("filter");
      var value = String($(this).data("value"));
      state.filters[filter] = value;
      $(".chip[data-filter='" + filter + "']").removeClass("is-active");
      $(this).addClass("is-active");
      applyFilters();
    });

    var searchDebounce;
    $("#search").on("input", function () {
      var v = $(this).val();
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(function () {
        state.filters.search = String(v || "").toLowerCase();
        applyFilters();
      }, 80);
    });

    $(document).on("click", "[data-open-item]", function (e) {
      e.preventDefault();
      var id = $(this).data("open-item");
      openDrawer(id);
    });

    $("#drawer-close, #drawer-scrim").on("click", closeDrawer);
    $(document).on("keydown", function (e) {
      if (e.key === "Escape") closeDrawer();
    });

    $(window).on("resize", function () {
      if (state.view === "deps") layoutDeps();
    });
  }

  // ─── Overview view ───────────────────────────────────────
  function renderOverview() {
    $.each(DATA.items, function (_, item) {
      if (item.tier === "never") return;
      var selector = "[data-tier-grid='" + item.surface + "-" + item.tier + "']";
      $(selector).append(cardHtml(item));
    });
  }

  function cardHtml(item) {
    var tags = (item.tags || []).slice(0, 4).map(function (t) {
      return "<span class='card-tag'>" + t + "</span>";
    }).join("");
    return (
      "<div class='card' data-id='" + item.id + "' data-surface='" + item.surface + "' " +
      "data-tier='" + item.tier + "' data-open-item='" + item.id + "'>" +
        "<span class='card-surface-dot'></span>" +
        "<div class='card-head'>" +
          "<span class='card-id'>" + item.id + "</span>" +
          "<span class='card-tier' data-tier='" + item.tier + "'>" + item.tier + "</span>" +
        "</div>" +
        "<div class='card-title'>" + escapeHtml(item.title) + "</div>" +
        "<div class='card-blurb'>" + escapeHtml(item.blurb) + "</div>" +
        "<div class='card-tags'>" + tags + "</div>" +
      "</div>"
    );
  }

  // ─── Timeline view ───────────────────────────────────────
  function renderTimeline() {
    var $tracks = $("#timeline-tracks").empty();
    var totalWeeks = 10;
    $.each(DATA.tracks, function (_, track) {
      var itemsInTrack = DATA.items.filter(function (i) {
        return i.track === track.id && i.week;
      });
      if (!itemsInTrack.length) return;
      var $row = $("<div class='timeline-track'></div>");
      $row.append("<span class='timeline-track-label'>" + track.label + "</span>");
      $.each(itemsInTrack, function (_, item) {
        var left = ((item.week.start - 1) / totalWeeks) * 100;
        var width = ((item.week.end - item.week.start + 1) / totalWeeks) * 100;
        var $bar = $(
          "<div class='timeline-bar' data-surface='" + item.surface + "' " +
          "data-id='" + item.id + "' data-open-item='" + item.id + "'></div>"
        );
        $bar.css({ left: left + "%", width: "calc(" + width + "% - 4px)" });
        if (item.critical) $bar.addClass("is-critical");
        $bar.html(
          "<span class='timeline-bar-id'>" + item.id + "</span>" +
          "<span>" + escapeHtml(truncate(item.title, 46)) + "</span>"
        );
        $row.append($bar);
      });
      $tracks.append($row);
    });
  }

  // ─── Board view ──────────────────────────────────────────
  function renderBoard() {
    var buckets = { backlog: [], next: [], after: [], later: [], never: [] };
    $.each(DATA.items, function (_, item) {
      if (item.tier === "never") buckets.never.push(item);
      else if (item.tier === "P0") buckets.next.push(item);
      else if (item.tier === "P1") buckets.after.push(item);
      else if (item.tier === "P2") buckets.later.push(item);
      else buckets.backlog.push(item);
    });
    $.each(buckets, function (col, list) {
      var $col = $("[data-col-list='" + col + "']").empty();
      if (!list.length) {
        $col.append("<div class='card' style='opacity:.4;cursor:default'><div class='card-blurb'>empty</div></div>");
        return;
      }
      $.each(list, function (_, item) { $col.append(cardHtml(item)); });
    });
  }

  // ─── Dependencies view ───────────────────────────────────
  function renderDeps() {
    var $nodes = $("#deps-nodes").empty();
    // Build depth buckets via topo order on 'depends'
    var byId = {};
    $.each(DATA.items, function (_, it) { byId[it.id] = it; });
    var depth = {};
    function computeDepth(id, seen) {
      if (depth[id] !== undefined) return depth[id];
      if (seen && seen[id]) return 0;
      seen = $.extend({}, seen || {}); seen[id] = true;
      var item = byId[id];
      if (!item) return 0;
      var maxDep = -1;
      $.each(item.depends || [], function (_, did) {
        var d = computeDepth(did, seen);
        if (d > maxDep) maxDep = d;
      });
      return (depth[id] = maxDep + 1);
    }
    $.each(DATA.items, function (_, it) {
      if (it.tier === "never") return;
      computeDepth(it.id);
    });

    // Place items
    var columns = {};
    $.each(DATA.items, function (_, it) {
      if (it.tier === "never") return;
      var col = depth[it.id] || 0;
      (columns[col] = columns[col] || []).push(it);
    });

    var colW = 260;
    var rowH = 78;
    var colMargin = 24;
    var maxCol = 0;
    $.each(columns, function (c) { if (+c > maxCol) maxCol = +c; });
    var maxRows = 0;
    $.each(columns, function (_, list) { if (list.length > maxRows) maxRows = list.length; });

    $.each(columns, function (colIdx, list) {
      $.each(list, function (i, item) {
        var $n = $(
          "<div class='dep-node' data-id='" + item.id + "' data-surface='" + item.surface + "' data-open-item='" + item.id + "'>" +
            "<div class='dep-node-id'>" + item.id + "</div>" +
            "<div class='dep-node-title'>" + escapeHtml(item.title) + "</div>" +
          "</div>"
        );
        $n.css({
          left: (colIdx * (colW + colMargin)) + "px",
          top: (i * rowH) + "px"
        });
        $nodes.append($n);
      });
    });

    $("#deps-nodes").css({
      minHeight: (maxRows * rowH + 40) + "px",
      minWidth: ((maxCol + 1) * (colW + colMargin)) + "px"
    });

    layoutDeps();
  }

  function layoutDeps() {
    var $svg = $("#deps-svg");
    var svgEl = $svg.get(0);
    if (!svgEl) return;
    $svg.empty();
    // size svg to match container
    var $wrap = $(".deps-wrap");
    var wrapW = Math.max($wrap.width(), $("#deps-nodes").prop("scrollWidth") || 0);
    var wrapH = Math.max($wrap.height(), $("#deps-nodes").prop("scrollHeight") || 0);
    $svg.attr("viewBox", "0 0 " + wrapW + " " + wrapH);
    $svg.attr("width", wrapW).attr("height", wrapH);

    // Collect node positions
    var positions = {};
    $(".dep-node").each(function () {
      var $n = $(this);
      var pos = $n.position();
      positions[$n.data("id")] = {
        x: pos.left,
        y: pos.top,
        w: $n.outerWidth(),
        h: $n.outerHeight()
      };
    });

    // Draw edges
    $.each(DATA.items, function (_, item) {
      if (item.tier === "never") return;
      $.each(item.depends || [], function (_, depId) {
        var from = positions[depId];
        var to = positions[item.id];
        if (!from || !to) return;
        var x1 = from.x + from.w;
        var y1 = from.y + from.h / 2;
        var x2 = to.x;
        var y2 = to.y + to.h / 2;
        var cx1 = x1 + 40;
        var cx2 = x2 - 40;
        var pathD = "M" + x1 + "," + y1 + " C" + cx1 + "," + y1 + " " + cx2 + "," + y2 + " " + x2 + "," + y2;
        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathD);
        path.setAttribute("class", "dep-edge");
        path.setAttribute("data-from", depId);
        path.setAttribute("data-to", item.id);
        svgEl.appendChild(path);
      });
    });
  }

  // ─── Pillars view ────────────────────────────────────────
  function renderPillars() {
    var $wrap = $("#pillars-grid").empty();
    $.each(DATA.pillars, function (_, pillar) {
      var items = pillar.items.map(function (iid) {
        var item = DATA.items.find(function (i) { return i.id === iid; });
        if (!item) return "";
        return (
          "<div class='pillar-item' data-open-item='" + item.id + "'>" +
            "<span>" + escapeHtml(item.title) + "</span>" +
            "<span><span class='pi-id'>" + item.id + "</span><span class='card-tier' data-tier='" + item.tier + "'>" + item.tier + "</span></span>" +
          "</div>"
        );
      }).join("");
      var surfaceColor = pillar.surface === "laptop" ? "var(--laptop)" : "var(--runner)";
      $wrap.append(
        "<div class='pillar' data-surface='" + pillar.surface + "'>" +
          "<div class='pillar-head'><span class='pillar-dot' style='background:" + surfaceColor + "'></span>" +
            "<span class='pillar-title'>" + escapeHtml(pillar.title) + "</span></div>" +
          "<div class='pillar-body'>" + escapeHtml(pillar.body) + "</div>" +
          "<div class='pillar-items'>" + items + "</div>" +
        "</div>"
      );
    });
  }

  // ─── Filtering ───────────────────────────────────────────
  function applyFilters() {
    var f = state.filters;
    var visible = 0;
    $(".card, .dep-node, .timeline-bar, .pillar-item").each(function () {
      var $el = $(this);
      var id = $el.data("id") || $el.data("open-item");
      var item = DATA.items.find(function (i) { return i.id === id; });
      if (!item) return;
      var show = true;
      if (f.surface !== "all" && item.surface !== f.surface) show = false;
      if (f.tier !== "all" && item.tier !== f.tier) show = false;
      if (f.search) {
        var hay = (item.title + " " + item.blurb + " " + (item.tags || []).join(" ") + " " + item.id).toLowerCase();
        if (hay.indexOf(f.search) === -1) show = false;
      }
      $el.toggleClass("is-filtered-out", !show);
      if (show && $el.hasClass("card")) visible++;
    });
    updateCounter(visible);
  }

  function updateCounter(visibleCards) {
    var total = DATA.items.filter(function (i) { return i.tier !== "never"; }).length;
    var v = typeof visibleCards === "number" ? visibleCards : total;
    var uniqueVisible = v / 3; // cards rendered in overview + board + pillars, avg
    $("#foot-counter").text("Showing " + Math.round(uniqueVisible) + " of " + total + " tracked items · 5 never-items excluded");
  }

  // ─── Drawer ──────────────────────────────────────────────
  function openDrawer(id) {
    var item = DATA.items.find(function (i) { return i.id === id; });
    if (!item) return;
    state.selectedId = id;
    window.history.replaceState(null, "", "#" + id);
    $("#drawer-eyebrow").text(item.id + " · " + (item.surface === "laptop" ? "Laptop surface" : "Runner surface"));
    $("#drawer-title").text(item.title);
    $("#drawer-meta").html(
      "<span class='card-tier' data-tier='" + item.tier + "'>" + item.tier + "</span>" +
      (item.critical ? "<span class='card-tag' style='color:var(--danger)'>critical path</span>" : "") +
      (item.week ? "<span class='card-tag'>W" + item.week.start + "–W" + item.week.end + "</span>" : "") +
      (item.tags || []).map(function (t) { return "<span class='card-tag'>" + t + "</span>"; }).join("")
    );
    $("#drawer-why").html(escapeHtml(item.why || item.blurb));
    var $scope = $("#drawer-scope").empty();
    (item.scope || []).forEach(function (s) {
      $scope.append("<li>" + escapeHtml(s) + "</li>");
    });
    if (!item.scope || !item.scope.length) $scope.append("<li style='opacity:.5'>—</li>");

    var $deps = $("#drawer-deps").empty();
    (item.depends || []).forEach(function (did) {
      var dep = DATA.items.find(function (i) { return i.id === did; });
      if (!dep) return;
      $deps.append(
        "<li class='is-link' data-open-item='" + dep.id + "'>" +
          "<span class='li-id'>" + dep.id + "</span>" + escapeHtml(dep.title) +
        "</li>"
      );
    });
    if (!item.depends || !item.depends.length) $deps.append("<li style='opacity:.5'>—</li>");

    var $un = $("#drawer-unblocks").empty();
    (item.unblocks || []).forEach(function (uid) {
      var un = DATA.items.find(function (i) { return i.id === uid; });
      if (!un) return;
      $un.append(
        "<li class='is-link' data-open-item='" + un.id + "'>" +
          "<span class='li-id'>" + un.id + "</span>" + escapeHtml(un.title) +
        "</li>"
      );
    });
    if (!item.unblocks || !item.unblocks.length) $un.append("<li style='opacity:.5'>—</li>");

    $("#drawer-source").text(item.source || "");

    // Highlight edges in deps graph
    $(".dep-edge").removeClass("is-active");
    $(".dep-edge[data-from='" + id + "'], .dep-edge[data-to='" + id + "']").addClass("is-active");
    $(".dep-node").removeClass("is-dim");
    if (state.view === "deps") {
      var connected = { [id]: true };
      (item.depends || []).forEach(function (d) { connected[d] = true; });
      (item.unblocks || []).forEach(function (u) { connected[u] = true; });
      $(".dep-node").each(function () {
        var nid = $(this).data("id");
        if (!connected[nid]) $(this).addClass("is-dim");
      });
    }

    $("#drawer").addClass("is-open").attr("aria-hidden", "false");
    $("#drawer-scrim").addClass("is-open");
  }

  function closeDrawer() {
    $("#drawer").removeClass("is-open").attr("aria-hidden", "true");
    $("#drawer-scrim").removeClass("is-open");
    $(".dep-edge").removeClass("is-active");
    $(".dep-node").removeClass("is-dim");
    state.selectedId = null;
    if (window.history.replaceState) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }

  // ─── Utils ───────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
})(jQuery);
