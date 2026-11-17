// Copyright 2026 Kestrel Contributors. Licensed under Apache-2.0. See NOTICE.
// Shared Rich Markdown, Image Artifact & 2D Vector SVG Mermaid Renderer for Kestrel mods.
import { div, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, readTextFile, writeTextFile, openOverlay, home, appHome, window } from "herdr";

export const MD_EXTS = new Set(["md", "mdc", "markdown", "mdx"]);
export const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);

export function extOf(path) {
  if (!path) return "";
  const clean = path.split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() || "";
  return base.includes(".") ? base.split(".").pop().toLowerCase() : "";
}

export function createDocState() {
  return {
    mermaidRaw: new Set(),
    carouselIdx: new Map(),
    readySvgs: new Set(),
    inflightSvgs: new Set(),
    readyImgs: new Map(),
    inflightImgs: new Set(),
  };
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function xmlEsc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHexAlpha(c, fallback = "#888888") {
  if (!c || typeof c !== "string") return fallback;
  if (c.startsWith("#") && c.length === 9) return c.slice(0, 7);
  return c;
}

export function ensureSvgAsset(state, hash, svgXml, cx) {
  if (home() === "/fixture") return null;
  const rel = `data/mermaid/${hash}.svg`;
  if (state.readySvgs.has(hash)) return rel;
  if (!state.inflightSvgs.has(hash) && cx) {
    state.inflightSvgs.add(hash);
    const full = `${appHome()}/${rel}`;
    cx.spawn(async (cx) => {
      try {
        const existing = await readTextFile(full);
        if (existing === null) {
          await writeTextFile(full, svgXml, null).catch(() => {});
        }
        state.readySvgs.add(hash);
      } catch {
      } finally {
        state.inflightSvgs.delete(hash);
        cx.notify();
      }
    });
  }
  return null;
}

export function ensureImageAsset(state, rawPath, on, cx) {
  if (home() === "/fixture" || !rawPath) return null;
  let clean = rawPath.trim();
  if (clean.startsWith("file://")) {
    try {
      clean = decodeURIComponent(clean.replace(/^file:\/\//, ""));
    } catch {
      clean = clean.replace(/^file:\/\//, "");
    }
  }
  clean = clean.split(/[?#]/)[0];
  const appDir = appHome().replace(/\/+$/, "");
  if (!on && clean.startsWith(appDir + "/")) {
    return clean.slice(appDir.length + 1);
  }
  const ext = extOf(clean) || "png";
  if (!IMG_EXTS.has(ext)) return null;
  const key = `${on || "local"}:${clean}`;
  if (state.readyImgs.has(key)) return state.readyImgs.get(key);
  if (!state.inflightImgs.has(key) && cx && !on) {
    state.inflightImgs.add(key);
    const hash = fnv1a(clean);
    const rel = `data/preview-cache/${hash}.${ext}`;
    const dest = `${appDir}/${rel}`;
    cx.spawn(async (cx) => {
      try {
        const r = await exec(
          "sh",
          ["-c", 'mkdir -p "$(dirname "$2")" && [ -f "$1" ] && cp -f "$1" "$2"', "kestrel-img-stage", clean, dest],
        );
        if (r.code === 0) {
          state.readyImgs.set(key, rel);
        } else {
          state.readyImgs.set(key, null);
        }
      } catch {
        state.readyImgs.set(key, null);
      } finally {
        state.inflightImgs.delete(key);
        cx.notify();
      }
    });
  }
  return null;
}

export function resolveLocalPath(href, baseDir) {
  if (!href) return null;
  let target = href.trim();
  if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) return null;
  if (target.startsWith("file://")) {
    try {
      target = decodeURIComponent(target.replace(/^file:\/\//, ""));
    } catch {
      target = target.replace(/^file:\/\//, "");
    }
  }
  target = target.split("#")[0].split("?")[0];
  if (!target) return null;
  if (target.startsWith("/")) return target;
  if (target.startsWith("~/")) return `${home()}/${target.slice(2)}`;
  if (baseDir) {
    const base = baseDir.replace(/\/+$/, "");
    return `${base}/${target.replace(/^\.\//, "")}`;
  }
  return null;
}

function openExternalUrl(url) {
  if (home() === "/fixture") return;
  const plat = window()?.platform;
  const cmd = plat === "macos" ? "open" : plat === "windows" ? "explorer" : "xdg-open";
  exec(cmd, [url]).catch(() => {});
}

// ---------------------------------------------------------------------------
// 2D Mermaid Parsers & Vector SVG Layout Engine
// ---------------------------------------------------------------------------

function cleanLabel(s) {
  return String(s ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/^["'`]|["'`]$/g, "")
    .trim();
}

function parseFlowNode(raw) {
  const s = raw.trim();
  let m;
  if (s === "[*]") return { id: "__start_end__", label: "●", shape: "state_dot" };
  m = s.match(/^([A-Za-z0-9_.-]+)\s*\(\(\(\s*([\s\S]*?)\s*\)\)\)$/);
  if (m) return { id: m[1], label: cleanLabel(m[2] || m[1]), shape: "circle" };
  m = s.match(/^([A-Za-z0-9_.-]+)\s*\(\(\s*([\s\S]*?)\s*\)\)$/);
  if (m) return { id: m[1], label: cleanLabel(m[2] || m[1]), shape: "circle" };
  m = s.match(/^([A-Za-z0-9_.-]+)\s*\(\[\s*([\s\S]*?)\s*\]\)$/);
  if (m) return { id: m[1], label: cleanLabel(m[2] || m[1]), shape: "stadium" };
  m = s.match(/^([A-Za-z0-9_.-]+)\s*\[\(\s*([\s\S]*?)\s*\)\]$/);
  if (m) return { id: m[1], label: cleanLabel(m[2] || m[1]), shape: "cylinder" };
  m = s.match(/^([A-Za-z0-9_.-]+)\s*\[\[\s*([\s\S]*?)\s*\]\]$/);
  if (m) return { id: m[1], label: cleanLabel(m[2] || m[1]), shape: "subroutine" };
  m = s.match(/^([A-Za-z0-9_.-]+)\s*\{\{\s*([\s\S]*?)\s*\}\}$/);
  if (m) return { id: m[1], label: cleanLabel(m[2] || m[1]), shape: "diamond" };
  m = s.match(/^([A-Za-z0-9_.-]+)\s*\{\s*([\s\S]*?)\s*\}$/);
  if (m) return { id: m[1], label: cleanLabel(m[2] || m[1]), shape: "diamond" };
  m = s.match(/^([A-Za-z0-9_.-]+)\s*\(\s*([\s\S]*?)\s*\)$/);
  if (m) return { id: m[1], label: cleanLabel(m[2] || m[1]), shape: "round" };
  m = s.match(/^([A-Za-z0-9_.-]+)\s*>\s*([\s\S]*?)\s*\]$/);
  if (m) return { id: m[1], label: cleanLabel(m[2] || m[1]), shape: "rect" };
  m = s.match(/^([A-Za-z0-9_.-]+)\s*\[\s*([\s\S]*?)\s*\]$/);
  if (m) return { id: m[1], label: cleanLabel(m[2] || m[1]), shape: "rect" };
  m = s.match(/^([A-Za-z0-9_.-]+)$/);
  if (m) return { id: m[1], label: m[1], shape: "rect" };
  const fallback = cleanLabel(s);
  return { id: fallback || "node", label: fallback || "node", shape: "rect" };
}

function arrowHeadSvg(x1, y1, x2, y2, color, size = 7) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const a1 = angle - Math.PI * 0.82;
  const a2 = angle + Math.PI * 0.82;
  const p1x = (x2 + size * Math.cos(a1)).toFixed(1);
  const p1y = (y2 + size * Math.sin(a1)).toFixed(1);
  const p2x = (x2 + size * Math.cos(a2)).toFixed(1);
  const p2y = (y2 + size * Math.sin(a2)).toFixed(1);
  return `<polygon points="${x2.toFixed(1)},${y2.toFixed(1)} ${p1x},${p1y} ${p2x},${p2y}" fill="${color}"/>`;
}

// Computes 2D layered Sugiyama positions for a directed graph of nodes & edges.
function layoutLayeredGraph(nodeList, edges, direction = "TD") {
  const horiz = direction === "LR" || direction === "RL";
  const reverse = direction === "BT" || direction === "RL";
  const byId = new Map(nodeList.map((n, idx) => [n.id, { ...n, order: idx }]));
  const adj = new Map();
  const indeg = new Map();
  for (const n of byId.values()) {
    adj.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
    adj.get(e.from).push(e.to);
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  }

  // Kahn + cycle-breaking longest-path rank assignment
  const rank = new Map();
  const remaining = new Set(byId.keys());
  const curIndeg = new Map(indeg);
  while (remaining.size > 0) {
    let roots = [...remaining].filter((id) => (curIndeg.get(id) || 0) <= 0);
    if (roots.length === 0) {
      // Break cycle by picking earliest-declared node
      const pick = [...remaining].sort((a, b) => byId.get(a).order - byId.get(b).order)[0];
      roots = [pick];
    }
    for (const u of roots) {
      remaining.delete(u);
      if (!rank.has(u)) rank.set(u, 0);
      const ru = rank.get(u);
      for (const v of adj.get(u) || []) {
        if (!remaining.has(v)) continue;
        rank.set(v, Math.max(rank.get(v) || 0, ru + 1));
        curIndeg.set(v, (curIndeg.get(v) || 1) - 1);
      }
    }
  }

  let maxRank = 0;
  for (const r of rank.values()) if (r > maxRank) maxRank = r;
  if (reverse) {
    for (const [id, r] of rank.entries()) rank.set(id, maxRank - r);
  }

  const layers = Array.from({ length: maxRank + 1 }, () => []);
  for (const n of byId.values()) {
    const r = rank.get(n.id) || 0;
    n.rank = r;
    layers[r].push(n);
  }

  // 2-pass barycenter crossing reduction
  const posInLayer = new Map();
  const refreshPos = () => {
    for (const layer of layers) layer.forEach((n, idx) => posInLayer.set(n.id, idx));
  };
  refreshPos();
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 1; r <= maxRank; r++) {
      layers[r].sort((a, b) => {
        const pa = edges.filter((e) => e.to === a.id && byId.get(e.from)?.rank === r - 1).map((e) => posInLayer.get(e.from) ?? 0);
        const pb = edges.filter((e) => e.to === b.id && byId.get(e.from)?.rank === r - 1).map((e) => posInLayer.get(e.from) ?? 0);
        const avgA = pa.length ? pa.reduce((s, x) => s + x, 0) / pa.length : a.order;
        const avgB = pb.length ? pb.reduce((s, x) => s + x, 0) / pb.length : b.order;
        return avgA - avgB || a.order - b.order;
      });
      refreshPos();
    }
  }

  // Node dimensions
  for (const n of byId.values()) {
    if (n.w && n.h) continue;
    if (n.shape === "state_dot") {
      n.w = 24;
      n.h = 24;
      continue;
    }
    const lines = String(n.label || n.id).split("\n");
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const extra = n.shape === "diamond" ? 26 : 0;
    n.w = Math.max(82, Math.min(230, Math.round(longest * 7.1 + 26 + extra)));
    n.h = Math.max(34, lines.length * 17 + 16);
  }

  const pad = 26;
  const rankGap = horiz ? 68 : 56;
  const sibGap = horiz ? 22 : 24;

  if (!horiz) {
    // Vertical flow (TD / BT)
    const layerWidths = layers.map((layer) =>
      layer.reduce((sum, n) => sum + n.w, 0) + Math.max(0, layer.length - 1) * sibGap,
    );
    const maxW = Math.max(240, ...layerWidths);
    let curY = pad;
    for (let r = 0; r <= maxRank; r++) {
      const layer = layers[r];
      if (!layer.length) continue;
      const lw = layerWidths[r];
      let curX = pad + Math.max(0, (maxW - lw) / 2);
      const maxH = layer.reduce((m, n) => Math.max(m, n.h), 34);
      for (const n of layer) {
        n.x = Math.round(curX);
        n.y = Math.round(curY + (maxH - n.h) / 2);
        curX += n.w + sibGap;
      }
      curY += maxH + rankGap;
    }
    return {
      nodes: [...byId.values()],
      byId,
      horiz,
      width: Math.round(maxW + pad * 2),
      height: Math.round(Math.max(90, curY - rankGap + pad)),
    };
  } else {
    // Horizontal flow (LR / RL)
    const layerHeights = layers.map((layer) =>
      layer.reduce((sum, n) => sum + n.h, 0) + Math.max(0, layer.length - 1) * sibGap,
    );
    const maxH = Math.max(90, ...layerHeights);
    let curX = pad;
    for (let r = 0; r <= maxRank; r++) {
      const layer = layers[r];
      if (!layer.length) continue;
      const lh = layerHeights[r];
      let curY = pad + Math.max(0, (maxH - lh) / 2);
      const maxW = layer.reduce((m, n) => Math.max(m, n.w), 84);
      for (const n of layer) {
        n.x = Math.round(curX + (maxW - n.w) / 2);
        n.y = Math.round(curY);
        curY += n.h + sibGap;
      }
      curX += maxW + rankGap;
    }
    return {
      nodes: [...byId.values()],
      byId,
      horiz,
      width: Math.round(Math.max(240, curX - rankGap + pad)),
      height: Math.round(maxH + pad * 2),
    };
  }
}

function buildGraphSvgAndLabels(layout, edges, subgraphs, t) {
  const strokeMain = stripHexAlpha(t.accent, "#61afef");
  const strokeMuted = stripHexAlpha(t.muted, "#8892a0");
  const borderCol = stripHexAlpha(t.border, "#3b4252");
  const raisedCol = stripHexAlpha(t.chrome, "#1e222a");

  const svgParts = [];
  const subBoxes = [];

  // Subgraph containers
  for (const sg of subgraphs) {
    const members = sg.nodes.map((id) => layout.byId.get(id)).filter(Boolean);
    if (!members.length) continue;
    const minX = Math.min(...members.map((m) => m.x)) - 14;
    const minY = Math.min(...members.map((m) => m.y)) - 26;
    const maxX = Math.max(...members.map((m) => m.x + m.w)) + 14;
    const maxY = Math.max(...members.map((m) => m.y + m.h)) + 12;
    const bx = Math.max(4, minX);
    const by = Math.max(4, minY);
    const bw = Math.max(60, maxX - bx);
    const bh = Math.max(40, maxY - by);
    svgParts.push(
      `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="8" fill="${raisedCol}" fill-opacity="0.45" stroke="${borderCol}" stroke-width="1.2" stroke-dasharray="5,4"/>`,
    );
    subBoxes.push({ title: sg.title, x: bx + 8, y: by + 4 });
  }

  const edgeLabels = [];
  for (const e of edges) {
    const u = layout.byId.get(e.from);
    const v = layout.byId.get(e.to);
    if (!u || !v) continue;
    const color = e.style === "thick" ? strokeMain : e.style === "dotted" ? strokeMuted : strokeMain;
    const dash = e.style === "dotted" ? ` stroke-dasharray="5,4"` : "";
    const width = e.style === "thick" ? 2.6 : 1.75;

    if (u.id === v.id) {
      const sx = u.x + u.w / 2 + 12;
      const sy = u.y;
      const ex = u.x + u.w;
      const ey = u.y + u.h / 2;
      svgParts.push(
        `<path d="M ${sx} ${sy} C ${sx + 28} ${sy - 28}, ${ex + 32} ${ey - 22}, ${ex} ${ey}" fill="none" stroke="${color}" stroke-width="${width}"${dash}/>`,
      );
      if (e.arrow !== false) svgParts.push(arrowHeadSvg(ex + 12, ey - 8, ex, ey, color, 6.5));
      if (e.label) edgeLabels.push({ text: e.label, x: ex + 8, y: sy - 18 });
      continue;
    }

    let x1, y1, x2, y2, cx1, cy1, cx2, cy2;
    if (!layout.horiz) {
      const downward = u.y <= v.y;
      x1 = u.x + u.w / 2;
      y1 = downward ? u.y + u.h : u.y;
      x2 = v.x + v.w / 2;
      y2 = downward ? v.y : v.y + v.h;
      const dy = Math.max(24, Math.abs(y2 - y1) * 0.48);
      cx1 = x1;
      cy1 = downward ? y1 + dy : y1 - dy;
      cx2 = x2;
      cy2 = downward ? y2 - dy : y2 + dy;
    } else {
      const rightward = u.x <= v.x;
      x1 = rightward ? u.x + u.w : u.x;
      y1 = u.y + u.h / 2;
      x2 = rightward ? v.x : v.x + v.w;
      y2 = v.y + v.h / 2;
      const dx = Math.max(26, Math.abs(x2 - x1) * 0.48);
      cx1 = rightward ? x1 + dx : x1 - dx;
      cy1 = y1;
      cx2 = rightward ? x2 - dx : x2 + dx;
      cy2 = y2;
    }

    svgParts.push(
      `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${cx1.toFixed(1)} ${cy1.toFixed(1)}, ${cx2.toFixed(1)} ${cy2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${width}"${dash}/>`,
    );
    if (e.arrow !== false) {
      svgParts.push(arrowHeadSvg(cx2, cy2, x2, y2, color, 7));
    }
    if (e.label) {
      const mx = 0.125 * x1 + 0.375 * cx1 + 0.375 * cx2 + 0.125 * x2;
      const my = 0.125 * y1 + 0.375 * cy1 + 0.375 * cy2 + 0.125 * y2;
      edgeLabels.push({ text: e.label, x: Math.round(mx), y: Math.round(my) });
    }
  }

  const svgXml = `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">${svgParts.join("")}</svg>`;
  return { svgXml, edgeLabels, subBoxes };
}

function parseFlowOrState(lines, isState) {
  const first = lines[0] || "";
  const dirMatch = first.match(/\b(TB|TD|BT|RL|LR)\b/i);
  let direction = dirMatch ? dirMatch[1].toUpperCase() : "TD";
  if (direction === "TB") direction = "TD";

  const nodes = new Map();
  const edges = [];
  const subgraphs = [];
  const sgStack = [];
  let starCounter = 0;

  const ensureNode = (raw, roleHint = "") => {
    const trimmed = raw.trim();
    if (trimmed === "[*]") {
      const id = roleHint === "end" ? `__end_${++starCounter}` : `__start_${++starCounter}`;
      const node = { id, label: roleHint === "end" ? "◉" : "●", shape: "state_dot" };
      nodes.set(id, node);
      if (sgStack.length) sgStack[sgStack.length - 1].nodes.push(id);
      return id;
    }
    const parsed = parseFlowNode(trimmed);
    const prev = nodes.get(parsed.id);
    if (!prev) {
      nodes.set(parsed.id, parsed);
    } else if (prev.label === prev.id && parsed.label !== parsed.id) {
      prev.label = parsed.label;
      prev.shape = parsed.shape;
    }
    if (sgStack.length && !sgStack[sgStack.length - 1].nodes.includes(parsed.id)) {
      sgStack[sgStack.length - 1].nodes.push(parsed.id);
    }
    return parsed.id;
  };

  for (const rawLine of lines.slice(1)) {
    const line = rawLine.replace(/;\s*$/, "").trim();
    if (!line) continue;
    const dirLine = line.match(/^direction\s+(TB|TD|BT|RL|LR)\b/i);
    if (dirLine) {
      direction = dirLine[1].toUpperCase() === "TB" ? "TD" : dirLine[1].toUpperCase();
      continue;
    }
    const sgMatch = line.match(/^subgraph\s+(.+)$/i);
    if (sgMatch) {
      const rest = sgMatch[1].trim();
      const br = rest.match(/^([A-Za-z0-9_.-]+)\s*\[\s*"?([^"\]]+)"?\s*\]$/);
      const title = cleanLabel(br ? br[2] : rest);
      const sg = { title, nodes: [] };
      subgraphs.push(sg);
      sgStack.push(sg);
      continue;
    }
    if (/^end\b/i.test(line)) {
      sgStack.pop();
      continue;
    }
    if (/^(classDef|class|style|linkStyle|click)\b/i.test(line)) continue;

    if (isState) {
      const stAlias = line.match(/^state\s+"([^"]+)"\s+as\s+([A-Za-z0-9_.-]+)/i);
      if (stAlias) {
        nodes.set(stAlias[2], { id: stAlias[2], label: stAlias[1], shape: "round" });
        continue;
      }
      const stDesc = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/);
      if (stDesc && !line.includes("-->")) {
        const id = ensureNode(stDesc[1]);
        const cur = nodes.get(id);
        if (cur) {
          cur.label = cur.label === id ? `${id}\n${stDesc[2].trim()}` : `${cur.label}\n${stDesc[2].trim()}`;
          cur.shape = "round";
        }
        continue;
      }
    }

    // Parse edge expressions (supports A -->|lbl| B, A -- lbl --> B, A -.-> B, A ==> B, A --- B, A & B --> C)
    let em =
      line.match(/^(.+?)\s*(-->|==>|-\.->|---)\s*\|([^|]*)\|\s*(.+)$/) ||
      line.match(/^(.+?)\s*--\s*([^-|>]+?)\s*(-->|-\.->|==>)\s*(.+)$/);
    if (em) {
      const isPipe = em[2] === "-->" || em[2] === "==>" || em[2] === "-.->" || em[2] === "---";
      const op = isPipe ? em[2] : em[3];
      const label = cleanLabel(isPipe ? em[3] : em[2]);
      const lhsParts = em[1].split(/\s*&\s*/);
      const rhsParts = em[4].split(/\s*&\s*/);
      const style = op === "==>" ? "thick" : op.includes(".") ? "dotted" : "solid";
      const arrow = op !== "---";
      for (const l of lhsParts) {
        for (const r of rhsParts) {
          edges.push({ from: ensureNode(l, "start"), to: ensureNode(r, "end"), label, style, arrow });
        }
      }
      continue;
    }

    // Chained or single unlabelled edges: A --> B --> C or StateA --> StateB : event
    if (/(-->|==>|-\.->|---)/.test(line)) {
      let work = line;
      let trailingLabel = "";
      if (isState && work.includes(":")) {
        const idx = work.indexOf(":");
        trailingLabel = cleanLabel(work.slice(idx + 1));
        work = work.slice(0, idx).trim();
      }
      const tokens = work.split(/\s*(-->|==>|-\.->|---)\s*/);
      if (tokens.length >= 3) {
        for (let i = 0; i + 2 < tokens.length; i += 2) {
          const op = tokens[i + 1];
          const lhsParts = tokens[i].split(/\s*&\s*/);
          const rhsParts = tokens[i + 2].split(/\s*&\s*/);
          const style = op === "==>" ? "thick" : op.includes(".") ? "dotted" : "solid";
          const arrow = op !== "---";
          const lbl = i + 3 >= tokens.length ? trailingLabel : "";
          for (const l of lhsParts) {
            for (const r of rhsParts) {
              edges.push({ from: ensureNode(l, "start"), to: ensureNode(r, "end"), label: lbl, style, arrow });
            }
          }
        }
        continue;
      }
    }

    if (/^[A-Za-z0-9_.-]+\s*[\[\(\{>]/.test(line)) {
      ensureNode(line);
    }
  }

  if (isState) {
    for (const n of nodes.values()) {
      if (n.shape === "rect") n.shape = "round";
    }
  }

  return { direction, nodes: [...nodes.values()], edges, subgraphs };
}

function renderGraphBody(t, parsed, hashBase, state, cx) {
  if (parsed.nodes.length === 0) return null;
  const layout = layoutLayeredGraph(parsed.nodes, parsed.edges, parsed.direction);
  const { svgXml, edgeLabels, subBoxes } = buildGraphSvgAndLabels(layout, parsed.edges, parsed.subgraphs, t);
  const hash = fnv1a(`${hashBase}|${layout.width}x${layout.height}|${svgXml}`);
  const svgRel = ensureSvgAsset(state, hash, svgXml, cx);

  return div()
    .w_full()
    .rounded(6)
    .bg(t.background)
    .overflow_x_scrollbar()
    .p(6)
    .child(
      div()
        .relative()
        .w(layout.width)
        .h(layout.height)
        .when(Boolean(svgRel), (el) => el.child(image(svgRel).w(layout.width).h(layout.height).absolute().left(0).top(0)))
        .children(
          subBoxes.map((sb) =>
            div()
              .absolute()
              .left(sb.x)
              .top(sb.y)
              .px(6)
              .py(1)
              .rounded(4)
              .bg(t.raised)
              .text_size(10)
              .font_semibold()
              .text_color(t.muted)
              .child(sb.title),
          ),
        )
        .children(
          layout.nodes.map((n) => {
            if (n.shape === "state_dot") {
              return div()
                .absolute()
                .left(n.x)
                .top(n.y)
                .w(n.w)
                .h(n.h)
                .rounded_full()
                .bg(t.raised)
                .border(2)
                .border_color(t.accent)
                .flex()
                .items_center()
                .justify_center()
                .text_size(11)
                .text_color(t.accent)
                .child(n.label);
            }
            const isDiamond = n.shape === "diamond";
            const isStadium = n.shape === "stadium" || n.shape === "circle";
            const isRound = n.shape === "round";
            const isCyl = n.shape === "cylinder";
            const borderCol = isDiamond ? t.ansi3 : isCyl ? t.ansi6 : isStadium ? t.ansi2 : t.accent;
            const radius = isStadium ? 18 : isRound ? 10 : 6;
            const lines = String(n.label || n.id).split("\n");
            return v_flex()
              .absolute()
              .left(n.x)
              .top(n.y)
              .w(n.w)
              .h(n.h)
              .px(8)
              .py(4)
              .rounded(radius)
              .bg(t.raised)
              .border(isCyl ? 2 : 1)
              .border_color(borderCol)
              .items_center()
              .justify_center()
              .tooltip(lines.join(" · "))
              .children(
                lines.map((ln, li) =>
                  div()
                    .max_w_full()
                    .truncate()
                    .text_size(li === 0 ? 11.2 : 10.2)
                    .font_medium()
                    .text_color(li === 0 ? t.foreground : t.muted)
                    .child(li === 0 && isDiamond ? `◆ ${ln}` : li === 0 && isCyl ? `⛁ ${ln}` : ln),
                ),
              );
          }),
        )
        .children(
          edgeLabels.map((lbl) => {
            const w = Math.max(36, Math.min(160, Math.round(lbl.text.length * 6.4 + 14)));
            return div()
              .absolute()
              .left(Math.max(2, lbl.x - Math.round(w / 2)))
              .top(Math.max(2, lbl.y - 10))
              .w(w)
              .h(20)
              .px(5)
              .rounded(4)
              .bg(t.background)
              .border(1)
              .border_color(t.border)
              .flex()
              .items_center()
              .justify_center()
              .text_size(10)
              .text_color(t.muted)
              .truncate()
              .tooltip(lbl.text)
              .child(lbl.text);
          }),
        ),
    );
}

function renderSequenceBody(t, lines, hashBase, state, cx) {
  const participants = [];
  const pIndex = new Map();
  const events = [];

  const ensureP = (id, label) => {
    if (!pIndex.has(id)) {
      pIndex.set(id, participants.length);
      participants.push({ id, label: cleanLabel(label || id) });
    } else if (label && participants[pIndex.get(id)].label === id) {
      participants[pIndex.get(id)].label = cleanLabel(label);
    }
    return pIndex.get(id);
  };

  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line || /^(autonumber|activate|deactivate)\b/i.test(line)) continue;
    const pm = line.match(/^(participant|actor)\s+([A-Za-z0-9_.-]+)(?:\s+as\s+(.+))?$/i);
    if (pm) {
      ensureP(pm[2], pm[3] || pm[2]);
      continue;
    }
    const nm = line.match(/^note\s+(left of|right of|over)\s+([^:]+):\s*(.+)$/i);
    if (nm) {
      const who = nm[2].split(",").map((s) => s.trim()).filter(Boolean);
      const idxs = who.map((w) => ensureP(w));
      events.push({ kind: "note", fromIdx: Math.min(...idxs), toIdx: Math.max(...idxs), text: cleanLabel(nm[3]) });
      continue;
    }
    const fm = line.match(/^(loop|alt|else|opt|par|critical)\b\s*(.*)$/i);
    if (fm) {
      events.push({ kind: "divider", tag: fm[1].toUpperCase(), text: cleanLabel(fm[2]) });
      continue;
    }
    if (/^end\b/i.test(line)) continue;
    const mm = line.match(/^([A-Za-z0-9_.-]+)\s*(--?>>?|--?[x)]|->|-->)\s*[+-]?([A-Za-z0-9_.-]+)\s*:\s*(.+)$/);
    if (mm) {
      const fi = ensureP(mm[1]);
      const ti = ensureP(mm[3]);
      events.push({
        kind: "msg",
        fromIdx: fi,
        toIdx: ti,
        dashed: mm[2].startsWith("--"),
        msg: cleanLabel(mm[4]),
      });
    }
  }

  if (participants.length === 0) return null;
  const colW = 152;
  const padX = 24;
  const headY = 12;
  const headH = 32;
  const rowH = 44;
  const width = Math.max(260, padX * 2 + (participants.length - 1) * colW + 128);
  const footY = headY + headH + 20 + events.length * rowH + 12;
  const height = footY + headH + 12;
  const centerX = (idx) => padX + 64 + idx * colW;

  const strokeMain = stripHexAlpha(t.accent, "#61afef");
  const strokeMuted = stripHexAlpha(t.muted, "#8892a0");
  const borderCol = stripHexAlpha(t.border, "#3b4252");
  const svgParts = [];

  for (let i = 0; i < participants.length; i++) {
    const cxPos = centerX(i);
    svgParts.push(
      `<line x1="${cxPos}" y1="${headY + headH}" x2="${cxPos}" y2="${footY}" stroke="${borderCol}" stroke-width="1.4" stroke-dasharray="5,4"/>`,
    );
  }

  const overlays = [];
  events.forEach((ev, idx) => {
    const y = headY + headH + 26 + idx * rowH;
    if (ev.kind === "msg") {
      const x1 = centerX(ev.fromIdx);
      const x2 = centerX(ev.toIdx);
      const col = ev.dashed ? strokeMuted : strokeMain;
      const dash = ev.dashed ? ` stroke-dasharray="5,4"` : "";
      if (ev.fromIdx === ev.toIdx) {
        svgParts.push(
          `<path d="M ${x1} ${y - 6} L ${x1 + 34} ${y - 6} L ${x1 + 34} ${y + 12} L ${x1} ${y + 12}" fill="none" stroke="${col}" stroke-width="1.7"${dash}/>`,
        );
        svgParts.push(arrowHeadSvg(x1 + 14, y + 12, x1, y + 12, col, 6.5));
        overlays.push({ kind: "self", x: x1 + 40, y: y - 8, text: ev.msg });
      } else {
        svgParts.push(`<line x1="${x1}" y1="${y + 6}" x2="${x2}" y2="${y + 6}" stroke="${col}" stroke-width="1.75"${dash}/>`);
        svgParts.push(arrowHeadSvg(x1, y + 6, x2, y + 6, col, 6.8));
        const left = Math.min(x1, x2);
        const span = Math.abs(x2 - x1);
        overlays.push({ kind: "msg", x: left + 8, w: Math.max(60, span - 16), y: y - 13, text: ev.msg });
      }
    } else if (ev.kind === "note") {
      const left = centerX(ev.fromIdx) - 52;
      const right = centerX(ev.toIdx) + 52;
      overlays.push({ kind: "note", x: Math.max(8, left), w: Math.max(104, right - left), y: y - 10, text: ev.text });
    } else if (ev.kind === "divider") {
      svgParts.push(
        `<rect x="12" y="${y - 8}" width="${width - 24}" height="24" rx="5" fill="none" stroke="${borderCol}" stroke-width="1" stroke-dasharray="4,3"/>`,
      );
      overlays.push({ kind: "divider", x: 18, y: y - 5, text: `[${ev.tag}] ${ev.text}` });
    }
  });

  const svgXml = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svgParts.join("")}</svg>`;
  const hash = fnv1a(`${hashBase}|seq|${svgXml}`);
  const svgRel = ensureSvgAsset(state, hash, svgXml, cx);

  const renderParticipantPill = (p, idx, top) =>
    div()
      .absolute()
      .left(centerX(idx) - 58)
      .top(top)
      .w(116)
      .h(headH)
      .px(8)
      .rounded(6)
      .bg(t.raised)
      .border(1)
      .border_color(t.accent)
      .flex()
      .items_center()
      .justify_center()
      .text_size(11.2)
      .font_semibold()
      .text_color(t.foreground)
      .truncate()
      .tooltip(p.label)
      .child(p.label);

  return div()
    .w_full()
    .rounded(6)
    .bg(t.background)
    .overflow_x_scrollbar()
    .p(6)
    .child(
      div()
        .relative()
        .w(width)
        .h(height)
        .when(Boolean(svgRel), (el) => el.child(image(svgRel).w(width).h(height).absolute().left(0).top(0)))
        .children(participants.map((p, idx) => renderParticipantPill(p, idx, headY)))
        .children(participants.map((p, idx) => renderParticipantPill(p, idx, footY)))
        .children(
          overlays.map((o) => {
            if (o.kind === "note") {
              return div()
                .absolute()
                .left(o.x)
                .top(o.y)
                .w(o.w)
                .px(8)
                .py(3)
                .rounded(5)
                .bg(t.chrome)
                .border(1)
                .border_color(t.ansi3)
                .text_size(10.5)
                .text_color(t.foreground)
                .truncate()
                .tooltip(o.text)
                .child(`📝 ${o.text}`);
            }
            if (o.kind === "divider") {
              return div()
                .absolute()
                .left(o.x)
                .top(o.y)
                .px(6)
                .py(1)
                .rounded(4)
                .bg(t.raised)
                .text_size(10)
                .font_semibold()
                .text_color(t.ansi5)
                .child(o.text);
            }
            if (o.kind === "self") {
              return div()
                .absolute()
                .left(o.x)
                .top(o.y)
                .max_w(160)
                .px(5)
                .py(1)
                .rounded(4)
                .bg(t.background)
                .text_size(10.5)
                .text_color(t.foreground)
                .truncate()
                .tooltip(o.text)
                .child(o.text);
            }
            return div()
              .absolute()
              .left(o.x)
              .top(o.y)
              .w(o.w)
              .flex()
              .justify_center()
              .child(
                div()
                  .max_w_full()
                  .px(6)
                  .py(1)
                  .rounded(4)
                  .bg(t.background)
                  .text_size(10.5)
                  .text_color(t.foreground)
                  .truncate()
                  .tooltip(o.text)
                  .child(o.text),
              );
          }),
        ),
    );
}

function renderClassOrErBody(t, lines, isEr, hashBase, state, cx) {
  const entities = new Map();
  const edges = [];
  let current = null;

  const ensureEnt = (name) => {
    const clean = name.replace(/^["']|["']$/g, "").trim();
    if (!entities.has(clean)) entities.set(clean, { id: clean, members: [] });
    return entities.get(clean);
  };

  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    if (current) {
      if (line === "}") {
        current = null;
      } else {
        current.members.push(line);
      }
      continue;
    }
    const openBlock = line.match(/^(?:class\s+)?([A-Za-z0-9_.-]+)\s*\{\s*$/);
    if (openBlock) {
      current = ensureEnt(openBlock[1]);
      continue;
    }
    if (isEr) {
      const erRel = line.match(/^([A-Za-z0-9_.-]+)\s+([|o}{]+--[|o}{]+|[|o}{]+\.\.[|o}{]+)\s+([A-Za-z0-9_.-]+)(?:\s*:\s*(.+))?$/);
      if (erRel) {
        ensureEnt(erRel[1]);
        ensureEnt(erRel[3]);
        edges.push({
          from: erRel[1],
          to: erRel[3],
          label: cleanLabel(erRel[4] || erRel[2]),
          style: erRel[2].includes("..") ? "dotted" : "solid",
          arrow: true,
        });
        continue;
      }
    } else {
      const clsRel = line.match(/^([A-Za-z0-9_.-]+)\s*(<\|--|\*--|o--|-->|\.\.>|\.\.\|>|--)\s*([A-Za-z0-9_.-]+)(?:\s*:\s*(.+))?$/);
      if (clsRel) {
        ensureEnt(clsRel[1]);
        ensureEnt(clsRel[3]);
        edges.push({
          from: clsRel[1],
          to: clsRel[3],
          label: cleanLabel(clsRel[4] || ""),
          style: clsRel[2].includes("..") ? "dotted" : "solid",
          arrow: clsRel[2] !== "--",
        });
        continue;
      }
      const memberLine = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/);
      if (memberLine) {
        ensureEnt(memberLine[1]).members.push(memberLine[2].trim());
        continue;
      }
    }
  }

  const nodeList = [...entities.values()].map((ent) => {
    const longest = [ent.id, ...ent.members].reduce((m, s) => Math.max(m, s.length), 0);
    const shownMembers = ent.members.slice(0, 8);
    return {
      id: ent.id,
      label: ent.id,
      members: shownMembers,
      moreCount: Math.max(0, ent.members.length - shownMembers.length),
      w: Math.max(128, Math.min(240, Math.round(longest * 6.8 + 26))),
      h: 30 + (shownMembers.length ? shownMembers.length * 17 + (ent.members.length > 8 ? 16 : 6) : 6),
    };
  });
  if (!nodeList.length) return null;

  const layout = layoutLayeredGraph(nodeList, edges, isEr ? "LR" : "TD");
  const { svgXml, edgeLabels } = buildGraphSvgAndLabels(layout, edges, [], t);
  const hash = fnv1a(`${hashBase}|cls|${svgXml}`);
  const svgRel = ensureSvgAsset(state, hash, svgXml, cx);

  return div()
    .w_full()
    .rounded(6)
    .bg(t.background)
    .overflow_x_scrollbar()
    .p(6)
    .child(
      div()
        .relative()
        .w(layout.width)
        .h(layout.height)
        .when(Boolean(svgRel), (el) => el.child(image(svgRel).w(layout.width).h(layout.height).absolute().left(0).top(0)))
        .children(
          layout.nodes.map((n) =>
            v_flex()
              .absolute()
              .left(n.x)
              .top(n.y)
              .w(n.w)
              .h(n.h)
              .rounded(6)
              .bg(t.raised)
              .border(1)
              .border_color(isEr ? t.ansi6 : t.accent)
              .overflow_hidden()
              .child(
                div()
                  .h(26)
                  .px(8)
                  .bg(t.chrome)
                  .border_b(n.members?.length ? 1 : 0)
                  .border_color(t.border)
                  .flex()
                  .items_center()
                  .justify_center()
                  .text_size(11.2)
                  .font_semibold()
                  .text_color(t.foreground)
                  .truncate()
                  .child(n.id),
              )
              .when(Boolean(n.members?.length), (el) =>
                el.child(
                  v_flex()
                    .px(8)
                    .py(3)
                    .gap(1)
                    .children(
                      n.members.map((m) =>
                        div().text_size(10.2).text_color(t.muted).truncate().tooltip(m).child(m),
                      ),
                    )
                    .when(n.moreCount > 0, (sub) =>
                      sub.child(div().text_size(9.8).text_color(t.dim).child(`+${n.moreCount} more…`)),
                    ),
                ),
              ),
          ),
        )
        .children(
          edgeLabels.map((lbl) => {
            const w = Math.max(38, Math.min(150, Math.round(lbl.text.length * 6.4 + 14)));
            return div()
              .absolute()
              .left(Math.max(2, lbl.x - Math.round(w / 2)))
              .top(Math.max(2, lbl.y - 10))
              .w(w)
              .h(19)
              .px(5)
              .rounded(4)
              .bg(t.background)
              .border(1)
              .border_color(t.border)
              .flex()
              .items_center()
              .justify_center()
              .text_size(10)
              .text_color(t.muted)
              .truncate()
              .child(lbl.text);
          }),
        ),
    );
}

function renderXyChartBody(t, lines, hashBase, state, cx) {
  let title = "";
  let xLabels = [];
  const bars = [];
  const lineSeries = [];
  let yMin = null;
  let yMax = null;

  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    const tm = line.match(/^title\s+"?([^"]+)"?$/i);
    if (tm) {
      title = tm[1].trim();
      continue;
    }
    const xm = line.match(/^x-axis(?:\s+"[^"]*")?\s*\[([^\]]+)\]/i);
    if (xm) {
      xLabels = xm[1].split(",").map((s) => cleanLabel(s));
      continue;
    }
    const ym = line.match(/^y-axis(?:\s+"[^"]*")?\s+(-?\d+(?:\.\d+)?)\s*-->\s*(-?\d+(?:\.\d+)?)/i);
    if (ym) {
      yMin = Number(ym[1]);
      yMax = Number(ym[2]);
      continue;
    }
    const bm = line.match(/^bar\s*\[([^\]]+)\]/i);
    if (bm) {
      bars.push(bm[1].split(",").map((v) => Number(v.trim())).filter((v) => !Number.isNaN(v)));
      continue;
    }
    const lm = line.match(/^line\s*\[([^\]]+)\]/i);
    if (lm) {
      lineSeries.push(lm[1].split(",").map((v) => Number(v.trim())).filter((v) => !Number.isNaN(v)));
    }
  }

  const allVals = [...bars.flat(), ...lineSeries.flat()];
  if (!allVals.length) return null;
  const minV = yMin !== null ? yMin : Math.min(0, ...allVals);
  const maxV = yMax !== null ? yMax : Math.max(...allVals, minV + 1);
  const spanV = Math.max(1e-6, maxV - minV);
  const count = Math.max(xLabels.length, ...bars.map((b) => b.length), ...lineSeries.map((l) => l.length));

  const W = Math.max(320, count * 56 + 80);
  const H = 200;
  const plotL = 46;
  const plotR = W - 18;
  const plotT = 18;
  const plotB = H - 32;
  const plotW = plotR - plotL;
  const plotH = plotB - plotT;
  const yOf = (v) => plotB - ((v - minV) / spanV) * plotH;
  const slotW = plotW / Math.max(1, count);

  const accent = stripHexAlpha(t.accent, "#61afef");
  const lineCol = stripHexAlpha(t.ansi2, "#98c379");
  const gridCol = stripHexAlpha(t.border, "#3b4252");
  const svgParts = [];

  for (let g = 0; g <= 4; g++) {
    const gy = plotT + (plotH * g) / 4;
    svgParts.push(`<line x1="${plotL}" y1="${gy.toFixed(1)}" x2="${plotR}" y2="${gy.toFixed(1)}" stroke="${gridCol}" stroke-width="1"/>`);
  }
  svgParts.push(`<line x1="${plotL}" y1="${plotT}" x2="${plotL}" y2="${plotB}" stroke="${gridCol}" stroke-width="1.5"/>`);

  bars.forEach((series, sIdx) => {
    const bw = Math.max(8, Math.min(34, (slotW * 0.64) / Math.max(1, bars.length)));
    series.forEach((val, idx) => {
      const x = plotL + idx * slotW + (slotW - bw * bars.length) / 2 + sIdx * bw;
      const y = yOf(val);
      const bh = Math.max(2, plotB - y);
      svgParts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${accent}" fill-opacity="0.85"/>`);
    });
  });

  lineSeries.forEach((series) => {
    const pts = series.map((val, idx) => `${(plotL + idx * slotW + slotW / 2).toFixed(1)},${yOf(val).toFixed(1)}`);
    if (pts.length >= 2) {
      svgParts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${lineCol}" stroke-width="2.2"/>`);
    }
    series.forEach((val, idx) => {
      const cxPos = plotL + idx * slotW + slotW / 2;
      const cyPos = yOf(val);
      svgParts.push(`<circle cx="${cxPos.toFixed(1)}" cy="${cyPos.toFixed(1)}" r="3.6" fill="${lineCol}"/>`);
    });
  });

  const svgXml = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svgParts.join("")}</svg>`;
  const hash = fnv1a(`${hashBase}|xy|${svgXml}`);
  const svgRel = ensureSvgAsset(state, hash, svgXml, cx);

  return v_flex()
    .w_full()
    .rounded(6)
    .bg(t.background)
    .p(8)
    .gap(4)
    .when(Boolean(title), (el) => el.child(div().text_size(11.5).font_semibold().text_color(t.foreground).px(4).child(title)))
    .child(
      div()
        .w_full()
        .overflow_x_scrollbar()
        .child(
          div()
            .relative()
            .w(W)
            .h(H)
            .when(Boolean(svgRel), (el) => el.child(image(svgRel).w(W).h(H).absolute().left(0).top(0)))
            .children(
              [0, 0.5, 1].map((frac, idx) => {
                const val = maxV - frac * spanV;
                return div()
                  .absolute()
                  .left(4)
                  .top(Math.round(plotT + frac * plotH - 7))
                  .w(38)
                  .text_right()
                  .text_size(9.5)
                  .text_color(t.dim)
                  .child(Number.isInteger(val) ? String(val) : val.toFixed(1));
              }),
            )
            .children(
              Array.from({ length: count }, (_, idx) => {
                const lbl = xLabels[idx] ?? String(idx + 1);
                return div()
                  .absolute()
                  .left(Math.round(plotL + idx * slotW))
                  .top(plotB + 6)
                  .w(Math.round(slotW))
                  .flex()
                  .justify_center()
                  .text_size(10)
                  .text_color(t.muted)
                  .truncate()
                  .child(lbl);
              }),
            ),
        ),
    );
}

export function renderMermaidBlock(t, code, idPrefix, idx, state, cx, opts = {}) {
  const key = `${idPrefix}-${idx}`;
  const showRaw = state.mermaidRaw.has(key);
  const lines = code
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("%%"));
  const header = (lines[0] || "diagram").toLowerCase();

  let kindLabel = "Mermaid · Diagram";
  if (header.startsWith("sequencediagram")) kindLabel = "Mermaid · Sequence Diagram";
  else if (header.startsWith("statediagram")) kindLabel = "Mermaid · State Diagram";
  else if (header.startsWith("classdiagram")) kindLabel = "Mermaid · Class Diagram";
  else if (header.startsWith("erdiagram")) kindLabel = "Mermaid · ER Diagram";
  else if (header.startsWith("xychart")) kindLabel = "Mermaid · XY Chart";
  else if (/^(flowchart|graph)\b/.test(header)) {
    const d = (header.match(/\b(tb|td|bt|lr|rl)\b/i)?.[1] || "TD").toUpperCase();
    kindLabel = `Mermaid · Flowchart (${d})`;
  }

  const hashBase = `${t.accent}|${t.border}|${t.chrome}`;
  let body = null;
  if (!showRaw) {
    if (header.startsWith("sequencediagram")) {
      body = renderSequenceBody(t, lines, hashBase, state, cx);
    } else if (header.startsWith("classdiagram")) {
      body = renderClassOrErBody(t, lines, false, hashBase, state, cx);
    } else if (header.startsWith("erdiagram")) {
      body = renderClassOrErBody(t, lines, true, hashBase, state, cx);
    } else if (header.startsWith("xychart")) {
      body = renderXyChartBody(t, lines, hashBase, state, cx);
    } else if (/^(flowchart|graph|statediagram)/.test(header)) {
      const parsed = parseFlowOrState(lines, header.startsWith("statediagram"));
      body = renderGraphBody(t, parsed, hashBase, state, cx);
    }
  }

  if (!body) {
    body = v_flex()
      .p(10)
      .gap(2)
      .bg(t.background)
      .rounded(6)
      .children(code.split("\n").map((l) => div().text_size(11.2).text_color(t.ansi6).child(l || " ")));
  }

  return v_flex()
    .w_full()
    .my(6)
    .p(8)
    .gap(6)
    .rounded(8)
    .bg(t.chrome)
    .border(1)
    .border_color(t.border)
    .child(
      h_flex()
        .justify_between()
        .items_center()
        .px(4)
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(div().size(7).rounded(4).bg(t.accent))
            .child(div().text_size(11).font_semibold().text_color(t.muted).child(kindLabel)),
        )
        .child(
          h_flex()
            .gap(5)
            .items_center()
            .when(Boolean(opts.filePath && !opts.isModal), (el) =>
              el.child(
                div()
                  .id(`mmd-zoom-${key}`)
                  .px(6)
                  .py(2)
                  .rounded(4)
                  .bg(t.raised)
                  .border(1)
                  .border_color(t.border)
                  .text_size(10)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .cursor_pointer()
                  .tooltip("Open document in large diagram viewer")
                  .on_click(() =>
                    openOverlay({
                      mod: "files",
                      kind: "dialog",
                      width: 940,
                      height: 720,
                      props: {
                        modalPreview: true,
                        previewFile: opts.filePath,
                        previewRoot: opts.rootDir || "",
                        previewOn: opts.on ?? null,
                      },
                    }),
                  )
                  .child("⤢ Zoom"),
              ),
            )
            .child(
              div()
                .id(`mmd-src-${key}`)
                .px(7)
                .py(2)
                .rounded(4)
                .bg(t.raised)
                .border(1)
                .border_color(t.border)
                .text_size(10)
                .text_color(t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .cursor_pointer()
                .on_click((_e, cx) => {
                  if (state.mermaidRaw.has(key)) state.mermaidRaw.delete(key);
                  else state.mermaidRaw.add(key);
                  cx.notify();
                })
                .child(showRaw ? "◈ Diagram" : "</> Source"),
            ),
        ),
    )
    .child(body);
}

// ---------------------------------------------------------------------------
// Rich Markdown Parser (Carousels, Mermaid, GitHub Alerts, Inline Images)
// ---------------------------------------------------------------------------

function splitSubBlocks(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let mdBuf = [];

  const flushMd = () => {
    const joined = mdBuf.join("\n").trim();
    if (joined) out.push({ kind: "markdown", content: joined });
    mdBuf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // GitHub / Antigravity alert: > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
    const alertMatch = line.match(/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
    if (alertMatch) {
      flushMd();
      const level = alertMatch[1].toUpperCase();
      const bodyLines = [];
      if (alertMatch[2].trim()) bodyLines.push(alertMatch[2].trim());
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) {
        i++;
        bodyLines.push(lines[i].replace(/^>\s?/, ""));
      }
      out.push({ kind: "alert", level, content: bodyLines.join("\n").trim() });
      continue;
    }

    // Standalone image line: ![caption](path)
    const imgMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      flushMd();
      out.push({ kind: "image", caption: imgMatch[1].trim(), src: imgMatch[2].trim() });
      continue;
    }

    mdBuf.push(line);
  }
  flushMd();
  return out;
}

export function parseRichBlocks(text) {
  if (!text || !text.trim()) return [];
  const blocks = [];
  // Match 4-backtick ```carousel ... ``` OR 3-backtick ```mermaid ... ```
  const tokenRe = /````carousel[ \t]*\r?\n([\s\S]*?)````|```mermaid[ \t]*\r?\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) {
      blocks.push(...splitSubBlocks(text.slice(last, m.index)));
    }
    if (m[1] !== undefined) {
      const slides = m[1]
        .split(/<!--\s*slide\s*-->/i)
        .map((s) => s.trim())
        .filter(Boolean);
      if (slides.length) blocks.push({ kind: "carousel", slides });
    } else if (m[2] !== undefined) {
      blocks.push({ kind: "mermaid", content: m[2].trim() });
    }
    last = tokenRe.lastIndex;
  }
  if (last < text.length) {
    blocks.push(...splitSubBlocks(text.slice(last)));
  }
  return blocks;
}

export function renderRichMarkdown(t, text, idPrefix, state, cx, opts = {}) {
  const blocks = parseRichBlocks(text);
  const handleLink = (url, cx) => {
    const local = resolveLocalPath(url, opts.baseDir);
    if (local) {
      if (opts.onOpenPath) {
        opts.onOpenPath(local, cx);
      } else {
        openOverlay({
          mod: "files",
          kind: "dialog",
          width: 900,
          height: 680,
          props: { modalPreview: true, previewFile: local, previewRoot: "", previewOn: opts.on ?? null },
        });
      }
      return;
    }
    if (/^https?:\/\//i.test(url)) openExternalUrl(url);
  };

  return blocks.map((b, idx) => {
    if (b.kind === "mermaid") {
      return renderMermaidBlock(t, b.content, idPrefix, idx, state, cx, opts);
    }

    if (b.kind === "carousel") {
      const cKey = `${idPrefix}-car-${idx}`;
      const total = b.slides.length;
      const cur = Math.min(total - 1, Math.max(0, state.carouselIdx.get(cKey) ?? 0));
      return v_flex()
        .w_full()
        .my(6)
        .p(10)
        .gap(8)
        .rounded(8)
        .bg(t.chrome)
        .border(1)
        .border_color(t.border)
        .child(
          h_flex()
            .justify_between()
            .items_center()
            .child(div().text_size(11).font_semibold().text_color(t.muted).child(`Carousel · Slide ${cur + 1} of ${total}`))
            .child(
              h_flex()
                .gap(5)
                .child(
                  div()
                    .id(`${cKey}-prev`)
                    .px(7)
                    .py(2)
                    .rounded(4)
                    .bg(t.raised)
                    .border(1)
                    .border_color(t.border)
                    .text_size(10.5)
                    .text_color(cur > 0 ? t.foreground : t.dim)
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      state.carouselIdx.set(cKey, (cur - 1 + total) % total);
                      cx.notify();
                    })
                    .child("◀ Prev"),
                )
                .child(
                  div()
                    .id(`${cKey}-next`)
                    .px(7)
                    .py(2)
                    .rounded(4)
                    .bg(t.raised)
                    .border(1)
                    .border_color(t.border)
                    .text_size(10.5)
                    .text_color(cur + 1 < total ? t.foreground : t.dim)
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      state.carouselIdx.set(cKey, (cur + 1) % total);
                      cx.notify();
                    })
                    .child("Next ▶"),
                ),
            ),
        )
        .children(renderRichMarkdown(t, b.slides[cur], `${cKey}-s${cur}`, state, cx, opts));
    }

    if (b.kind === "alert") {
      const meta = {
        NOTE: { icon: "ℹ", label: "Note", color: t.accent },
        TIP: { icon: "✦", label: "Tip", color: t.ansi2 },
        IMPORTANT: { icon: "★", label: "Important", color: t.ansi5 },
        WARNING: { icon: "⚠", label: "Warning", color: t.ansi3 },
        CAUTION: { icon: "⛔", label: "Caution", color: t.ansi1 },
      }[b.level] || { icon: "ℹ", label: b.level, color: t.accent };

      return v_flex()
        .w_full()
        .my(5)
        .p(10)
        .gap(5)
        .rounded(7)
        .bg(t.chrome)
        .border_l(3)
        .border_color(meta.color)
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(div().text_size(11.5).font_semibold().text_color(meta.color).child(`${meta.icon} ${meta.label}`)),
        )
        .when(Boolean(b.content), (el) =>
          el.child(
            TextView.markdown(`${idPrefix}-al-${idx}`, b.content)
              .selectable(true)
              .on_link_click(handleLink),
          ),
        );
    }

    if (b.kind === "image") {
      const localPath = resolveLocalPath(b.src, opts.baseDir);
      const assetRel = localPath ? ensureImageAsset(state, localPath, opts.on ?? null, cx) : null;
      return v_flex()
        .w_full()
        .my(6)
        .p(10)
        .gap(6)
        .rounded(8)
        .bg(t.chrome)
        .border(1)
        .border_color(t.border)
        .items_center()
        .when(Boolean(assetRel), (el) =>
          el.child(
            div()
              .id(`${idPrefix}-img-${idx}`)
              .cursor_pointer()
              .tooltip("Click to inspect image full-size")
              .on_click(() =>
                openOverlay({
                  mod: "files",
                  kind: "dialog",
                  width: 900,
                  height: 700,
                  props: { modalPreview: true, previewFile: localPath, previewRoot: "", previewOn: opts.on ?? null },
                }),
              )
              .child(image(assetRel).max_w_full().rounded(6)),
          ),
        )
        .when(!assetRel, (el) =>
          el.child(div().text_size(11.5).text_color(t.dim).child(`🖼 ${localPath || b.src}`)),
        )
        .when(Boolean(b.caption), (el) =>
          el.child(div().text_size(11).text_color(t.muted).child(b.caption)),
        );
    }

    return TextView.markdown(`${idPrefix}-md-${idx}`, b.content)
      .selectable(true)
      .on_link_click(handleLink);
  });
}
