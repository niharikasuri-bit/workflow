(() => {
  'use strict';

  /* ================= Constants ================= */
  const NODE_W = 208;
  const NODE_H = 72;
  const GRID = 10;
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 2;
  const ZOOM_STEP = 1.2;
  const HOUR_MS = 60 * 60 * 1000;
  const STORAGE_KEY = 'workflow-designer.v1';

  const TYPES = {
    start: { label: 'Start', name: 'Start state' },
    intermediate: { label: 'Intermediate', name: 'Intermediate state' },
    end: { label: 'End', name: 'End state' },
  };
  const TYPE_ORDER = { start: 0, intermediate: 1, end: 2 };
  const ROLE_SUGGESTIONS = ['CITIZEN', 'VERIFIER', 'APPROVER'];

  /* ================= Helpers ================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'type', 'name', 'id', 'min', 'max', 'step', 'placeholder', 'tabIndex', 'htmlFor', 'textContent']);

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, val] of Object.entries(props)) {
      if (val === null || val === undefined || val === false) continue;
      if (key === 'class') node.className = val;
      else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2).toLowerCase(), val);
      else if (PROPS.has(key)) node[key] = val;
      else node.setAttribute(key, val === true ? '' : val);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const svgEl = (tag, attrs = {}) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  const icon = (d, size = 16) => {
    const s = svgEl('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true' });
    s.append(svgEl('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return s;
  };
  const ICONS = {
    close: 'M6 6l12 12M18 6L6 18',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    arrow: 'M5 12h14M13 6l6 6-6 6',
    plus: 'M12 5v14M5 12h14',
    back: 'M19 12H5M11 6l-6 6 6 6',
  };

  let seq = 0;
  const uid = (prefix) => `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}`;
  const snap = (n) => Math.round(n / GRID) * GRID;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const toCode = (text) =>
    String(text || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

  /* ================= Model ================= */
  let wf = load() || { name: 'Complaint resolution', states: [], actions: [] };
  let view = { x: 60, y: 120, zoom: 1 };
  let selected = null; // { kind: 'state' | 'action', id }
  let connectFrom = null; // click-to-connect source state id
  let issuesOpen = false;

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (data && Array.isArray(data.states) && Array.isArray(data.actions)) return data;
    } catch { /* ignore */ }
    return null;
  }
  let saveTimer;
  function save() {
    $('#savedNote').hidden = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(wf)); } catch { /* storage unavailable */ }
    }, 150);
  }

  const stateById = (id) => wf.states.find((s) => s.id === id);
  const actionById = (id) => wf.actions.find((a) => a.id === id);
  const startState = () => wf.states.find((s) => s.type === 'start');
  const outgoing = (id) => wf.actions.filter((a) => a.from === id);
  const incoming = (id) => wf.actions.filter((a) => a.to === id);

  /* ================= DOM refs ================= */
  const viewport = $('#viewport');
  const world = $('#world');
  const nodesLayer = $('#nodes');
  const labelsLayer = $('#labels');
  const edgeGroup = $('#edgeGroup');
  const ghostEdge = $('#ghostEdge');
  const statsEl = $('#stats');
  const inspector = $('#inspector');
  const emptyState = $('#emptyState');
  const zoomLabel = $('#zoomLabel');
  const toastEl = $('#toast');

  /* ================= Mutations ================= */
  function commit() {
    save();
    renderCanvas();
    renderStats();
    refreshTodoBox();
  }


  function addState(type, pos) {
    if (type === 'start' && startState()) {
      toast('A workflow has one start state. It is already on the canvas.');
      select('state', startState().id);
      ensureVisible(startState());
      return;
    }
    const sameType = wf.states.filter((s) => s.type === type).length;
    // End states are always numbered ("End state 1", "End state 2"), skipping names already taken.
    const numbered = (base) => {
      const used = new Set(wf.states.map((st) => st.name));
      let n = sameType + 1;
      while (used.has(`${base} ${n}`)) n++;
      return `${base} ${n}`;
    };
    const name = type === 'start' ? 'Start' : type === 'end' ? numbered('End state') : numbered('State');
    const p = pos || nextSlot(type);
    const state = { id: uid('s'), type, name, description: '', slaHours: type === 'end' ? 0 : 24, x: snap(p.x), y: snap(p.y) };
    wf.states.push(state);
    commit();
    select('state', state.id, { focusName: true });
    ensureVisible(state);
    toast(`${TYPES[type].name} added`);
  }

  function nextSlot(type) {
    const anchor = (selected?.kind === 'state' && stateById(selected.id)) || wf.states[wf.states.length - 1];
    let pos;
    if (!anchor) {
      const r = viewport.getBoundingClientRect();
      pos = { x: (r.width * 0.3 - view.x) / view.zoom, y: (r.height / 2 - view.y) / view.zoom - NODE_H / 2 };
    } else {
      pos = { x: anchor.x + NODE_W + 100, y: anchor.y };
      if (type === 'start') pos.x = Math.min(...wf.states.map((s) => s.x)) - NODE_W - 100;
    }
    // Step down until the slot is free.
    let guard = 0;
    while (wf.states.some((s) => Math.abs(s.x - pos.x) < NODE_W + 20 && Math.abs(s.y - pos.y) < NODE_H + 20) && guard++ < 50) {
      pos.y += NODE_H + 50;
    }
    return pos;
  }

  function canConnect(fromId, toId, silent) {
    const from = stateById(fromId);
    const to = stateById(toId);
    let msg = '';
    if (!from || !to) msg = 'Pick two states to connect.';
    else if (from.type === 'end') msg = 'End states close the workflow, so no actions can leave them.';
    else if (fromId === toId) msg = 'An action has to move to a different state.';
    if (msg && !silent) toast(msg);
    return !msg;
  }

  function suggestActionName(fromId, toId) {
    const from = stateById(fromId);
    const to = stateById(toId);
    if (from?.type === 'start') return 'Submit';
    if (to?.type === 'end') return /reject/i.test(to.name) ? 'Reject' : 'Close';
    if (to && from && to.x < from.x) return 'Send back';
    return 'Forward';
  }

  function addAction(fromId, toId, name, roles = []) {
    if (!canConnect(fromId, toId)) return null;
    const action = {
      id: uid('a'),
      name: (name || '').trim() || suggestActionName(fromId, toId),
      description: '',
      from: fromId,
      to: toId,
      roles: [...roles],
    };
    wf.actions.push(action);
    commit();
    return action;
  }

  /* Every delete goes through this popup:
     Title "Proceed to delete "X"?", description, Cancel (secondary) / Delete (primary). */
  const deleteDialog = $('#deleteDialog');
  let pendingDelete = null;

  function confirmDelete(name, onConfirm, extra = '', { title, question, cta = 'Delete', kind = '' } = {}) {
    const what = kind ? `${kind.toLowerCase()} ` : '';
    $('#delTitle').textContent = title || `Proceed to delete ${what}"${name}"?`;
    $('#delDesc').replaceChildren(
      ...(question
        ? [question]
        : [`Are you sure you want to delete ${what}`, el('strong', {}, `"${name}"`), '?']),
      ` ${extra ? extra + ' ' : ''}This action cannot be undone.`
    );
    $('#delConfirm').textContent = cta;
    pendingDelete = onConfirm;
    deleteDialog.showModal();
    $('#delCancel').focus(); // the safe choice is focused first
  }
  $('#delConfirm').addEventListener('click', () => {
    const run = pendingDelete;
    pendingDelete = null;
    deleteDialog.close();
    run?.();
  });
  deleteDialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => deleteDialog.close()));
  deleteDialog.addEventListener('click', (e) => { if (e.target === deleteDialog) deleteDialog.close(); });
  deleteDialog.addEventListener('close', () => { pendingDelete = null; });

  function deleteState(id) {
    const s = stateById(id);
    if (!s) return;
    const linked = wf.actions.filter((a) => a.from === id || a.to === id).length;
    confirmDelete(s.name, () => removeState(id), linked ? `Its ${plural(linked, 'action')} will be deleted too.` : '', { kind: 'State' });
  }

  function removeState(id) {
    const s = stateById(id);
    if (!s) return;
    wf.states = wf.states.filter((x) => x.id !== id);
    wf.actions = wf.actions.filter((a) => a.from !== id && a.to !== id);
    if (connectFrom === id) connectFrom = null;
    commit();
    select(null);
    toast(`"${s.name}" deleted`);
  }

  function deleteAction(id) {
    const a = actionById(id);
    if (!a) return;
    confirmDelete(a.name, () => removeAction(id), '', { kind: 'Action' });
  }

  function removeAction(id) {
    const a = actionById(id);
    if (!a) return;
    wf.actions = wf.actions.filter((x) => x.id !== id);
    commit();
    if (selected?.kind === 'action' && selected.id === id) select('state', a.from);
    else renderInspector();
    toast(`Action "${a.name}" deleted`);
  }

  /* ================= Selection ================= */
  function select(kind, id, opts = {}) {
    const next = kind ? { kind, id } : null;
    if (!next || !selected || next.kind !== selected.kind || next.id !== selected.id) {
      renaming = null;
      addingRole = false;
      renamingChecklist = false;
    }
    selected = next;
    renderCanvas();
    renderInspector(opts);
  }

  /* ================= View / zoom ================= */
  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    const g = 20 * view.zoom;
    viewport.style.backgroundSize = `${g}px ${g}px`;
    viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
    zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
    $('#zoomInBtn').disabled = view.zoom >= MAX_ZOOM;
    $('#zoomOutBtn').disabled = view.zoom <= MIN_ZOOM;
  }

  function zoomTo(nextZoom, cx, cy) {
    const r = viewport.getBoundingClientRect();
    const px = cx === undefined ? r.width / 2 : cx - r.left;
    const py = cy === undefined ? r.height / 2 : cy - r.top;
    const z = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const wx = (px - view.x) / view.zoom;
    const wy = (py - view.y) / view.zoom;
    view.zoom = z;
    view.x = px - wx * z;
    view.y = py - wy * z;
    applyView();
  }

  /** Default view: 100% zoom with the workflow centred in the canvas. */
  function resetView() {
    const r = viewport.getBoundingClientRect();
    view.zoom = 1;
    if (!wf.states.length) {
      view.x = 60;
      view.y = 120;
    } else {
      const minX = Math.min(...wf.states.map((s) => s.x));
      const minY = Math.min(...wf.states.map((s) => s.y));
      const maxX = Math.max(...wf.states.map((s) => s.x + NODE_W));
      const maxY = Math.max(...wf.states.map((s) => s.y + NODE_H));
      view.x = Math.round(r.width / 2 - (minX + maxX) / 2);
      view.y = Math.round(r.height / 2 - (minY + maxY) / 2);
    }
    applyView();
  }

  function zoomToFit() {
    const r = viewport.getBoundingClientRect();
    if (!wf.states.length) {
      view = { x: 60, y: 120, zoom: 1 };
      applyView();
      return;
    }
    const minX = Math.min(...wf.states.map((s) => s.x));
    const minY = Math.min(...wf.states.map((s) => s.y));
    const maxX = Math.max(...wf.states.map((s) => s.x + NODE_W));
    const maxY = Math.max(...wf.states.map((s) => s.y + NODE_H));
    const padX = 80;
    const padTop = 60;
    const padBottom = 140; // room for back-loops and the zoom controls
    const w = maxX - minX;
    const h = maxY - minY;
    const z = clamp(Math.min((r.width - padX * 2) / w, (r.height - padTop - padBottom) / h), MIN_ZOOM, 1);
    view.zoom = z;
    view.x = (r.width - w * z) / 2 - minX * z;
    view.y = padTop + (r.height - padTop - padBottom - h * z) / 2 - minY * z;
    applyView();
  }

  function ensureVisible(s) {
    const r = viewport.getBoundingClientRect();
    const left = s.x * view.zoom + view.x;
    const top = s.y * view.zoom + view.y;
    const right = left + NODE_W * view.zoom;
    const bottom = top + NODE_H * view.zoom;
    if (left < 20 || top < 20 || right > r.width - 20 || bottom > r.height - 70) {
      view.x = r.width / 2 - (s.x + NODE_W / 2) * view.zoom;
      view.y = r.height / 2 - (s.y + NODE_H / 2) * view.zoom;
      applyView();
    }
  }

  const toWorld = (clientX, clientY) => {
    const r = viewport.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.zoom, y: (clientY - r.top - view.y) / view.zoom };
  };

  /* ================= Canvas rendering ================= */
  function renderCanvas() {
    const focusedId = document.activeElement?.closest?.('.node')?.dataset.id;

    nodesLayer.replaceChildren(...wf.states.map(nodeEl));
    renderEdges();

    emptyState.hidden = wf.states.length > 0;
    $('#clearBtn').setAttribute('aria-disabled', String(wf.states.length === 0));
    viewport.classList.toggle('is-connecting', !!connectFrom);

    // Palette: one start state per workflow.
    const startBtn = $('.palette-item[data-type="start"]');
    const hasStart = !!startState();
    startBtn.disabled = hasStart;
    startBtn.title = hasStart ? 'A workflow has one start state' : '';

    if (focusedId) nodesLayer.querySelector(`[data-id="${focusedId}"]`)?.focus();
  }

  /** The same icons as the left panel: play (start), route (intermediate), square (end). */
  function stateIcon(type) {
    const svg = svgEl('svg', { viewBox: '0 0 24 24', width: 18, height: 18 });
    if (type === 'start') {
      svg.append(svgEl('path', { d: 'M7 4.5v15l12-7.5z', fill: 'currentColor', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round' }));
    } else if (type === 'intermediate') {
      const g = svgEl('g', { transform: 'rotate(90 12 12)', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      g.append(
        svgEl('circle', { cx: 6, cy: 19, r: 2.5, fill: 'currentColor' }),
        svgEl('path', { d: 'M8.5 19h9a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15.5' }),
        svgEl('circle', { cx: 18, cy: 5, r: 2.5, fill: 'currentColor' })
      );
      svg.append(g);
    } else {
      svg.setAttribute('width', 15);
      svg.setAttribute('height', 15);
      svg.append(svgEl('rect', { x: 4, y: 4, width: 16, height: 16, rx: 3, fill: 'currentColor' }));
    }
    return svg;
  }

  function nodeEl(s) {
    const outs = outgoing(s.id).length;
    const ins = incoming(s.id).length;
    const isSel = selected?.kind === 'state' && selected.id === s.id;
    const classes = ['node', `node--${s.type}`];
    if (isSel) classes.push('is-selected');
    if (connectFrom === s.id) classes.push('is-source');
    if (connectFrom && connectFrom !== s.id) classes.push('is-target');

    const nodeIssues = validate().filter((i) => i.state === s.id);
    if (nodeIssues.length) classes.push('has-issue');

    const node = el(
      'div',
      {
        class: classes.join(' '),
        'data-id': s.id,
        role: 'button',
        tabIndex: 0,
        'aria-pressed': String(isSel),
        'aria-label': `${TYPES[s.type].name}: ${s.name}. ${outs} out, ${ins} in.${nodeIssues.length ? ` Required: ${nodeIssues.map((i) => i.todo || i.title).join(' ')}` : ''} Arrow keys move it, C connects it.`,
        style: `left:${s.x}px;top:${s.y}px`,
      },
      el('span', { class: 'node__icon', 'aria-hidden': 'true' }, stateIcon(s.type)),
      el(
        'span',
        { class: 'node__body' },
        el('span', { class: 'node__type' }, TYPES[s.type].label),
        el('span', { class: 'node__name', title: s.name }, s.name || 'Untitled state')
      ),
      nodeIssues.length
        ? el('span', {
            class: 'node__issue',
            'aria-hidden': 'true',
            'data-tip': nodeIssues.map((i) => i.todo || i.title).join('\n'),
            onMouseenter: (e) => showTip(e.currentTarget),
            onMouseleave: () => hideTip(100),
          }, '!')
        : null,
      s.type !== 'end' ? el('span', { class: 'node__handle', title: 'Drag to another state to connect, or click then pick a state', 'aria-hidden': 'true' }) : null
    );
    node.addEventListener('keydown', (e) => onNodeKey(e, s));
    return node;
  }

  function edgeGeometry(a, lane, laneCount) {
    const s = stateById(a.from);
    const t = stateById(a.to);
    const sx = s.x + NODE_W;
    const sy = s.y + NODE_H / 2;
    const tx = t.x - 2;
    const ty = t.y + NODE_H / 2;
    const off = (lane - (laneCount - 1) / 2) * 44;
    const backward = tx < sx + 30;
    let c1;
    let c2;
    if (!backward) {
      const c = Math.max(50, (tx - sx) / 2);
      c1 = [sx + c, sy + off];
      c2 = [tx - c, ty + off];
    } else {
      const drop = Math.abs(sy - ty) < NODE_H + 20 ? NODE_H + 50 : 0;
      c1 = [sx + 110, sy + drop + Math.abs(off)];
      c2 = [tx - 110, ty + drop + Math.abs(off)];
    }
    const d = `M${sx},${sy} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${tx},${ty}`;
    const mid = {
      x: 0.125 * sx + 0.375 * c1[0] + 0.375 * c2[0] + 0.125 * tx,
      y: 0.125 * sy + 0.375 * c1[1] + 0.375 * c2[1] + 0.125 * ty,
    };
    return { d, mid };
  }

  function renderEdges() {
    edgeGroup.replaceChildren();
    labelsLayer.replaceChildren();

    // Spread actions that share the same pair of states so they don't overlap.
    const lanes = new Map();
    for (const a of wf.actions) {
      const key = [a.from, a.to].sort().join('|');
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push(a.id);
    }

    for (const a of wf.actions) {
      if (!stateById(a.from) || !stateById(a.to)) continue;
      const group = lanes.get([a.from, a.to].sort().join('|'));
      const { d, mid } = edgeGeometry(a, group.indexOf(a.id), group.length);
      const isSel = selected?.kind === 'action' && selected.id === a.id;
      const related = selected?.kind === 'state' && (a.from === selected.id || a.to === selected.id);

      const g = svgEl('g', { class: `edge${isSel ? ' is-selected' : ''}${related ? ' is-related' : ''}`, 'data-id': a.id });
      g.append(svgEl('path', { d, class: 'edge__hit' }));
      g.append(svgEl('path', { d, class: 'edge__line', 'marker-end': `url(#${isSel ? 'arrowSelected' : 'arrow'})` }));
      edgeGroup.append(g);

      labelsLayer.append(
        el(
          'button',
          {
            type: 'button',
            class: `edge-label${isSel ? ' is-selected' : ''}`,
            'data-action': a.id,
            style: `left:${mid.x}px;top:${mid.y}px`,
            title: `${a.name}: ${stateById(a.from).name} → ${stateById(a.to).name}`,
            'aria-label': `Action ${a.name}, from ${stateById(a.from).name} to ${stateById(a.to).name}`,
            onClick: () => select('action', a.id),
          },
          a.name || 'Untitled action'
        )
      );
    }
  }

  /* ================= Stats panel ================= */
  /**
   * Each issue says what is wrong (title), why it matters and how to fix it
   * (detail), and offers a one-click fix that takes the user to the right place.
   */
  function validate() {
    const issues = [];
    if (!wf.states.length) return issues;
    const start = startState();
    if (!start) {
      issues.push({
        title: 'No start state',
        detail: 'Every workflow needs one state where applications begin.',
        fix: { label: 'Add Start State', run: () => addState('start') },
      });
    }
    if (!wf.states.some((s) => s.type === 'end')) {
      issues.push({
        title: 'No end state',
        detail: 'Add at least one end state, like Resolved or Rejected, so applications can close.',
        fix: { label: 'Add End State', run: () => addState('end') },
      });
    }

    const seen = new Set();
    for (const s of wf.states) {
      const key = s.name.trim().toLowerCase();
      if (seen.has(key)) {
        issues.push({
          state: s.id,
          title: `Two states are called "${s.name}"`,
          todo: 'Give this state a name no other state uses.',
          detail: 'The code uses state names to link states, so each name must be different. Rename one of them.',
          fix: { label: 'Rename', run: () => goToState(s.id, { focusName: true }) },
        });
      }
      seen.add(key);
    }

    const reached = new Set();
    if (start) {
      const queue = [start.id];
      while (queue.length) {
        const id = queue.shift();
        if (reached.has(id)) continue;
        reached.add(id);
        outgoing(id).forEach((a) => queue.push(a.to));
      }
    }
    for (const s of wf.states) {
      if (start && !reached.has(s.id)) {
        issues.push({
          state: s.id,
          title: `"${s.name}" can't be reached`,
          todo: 'Connect an earlier state to this one.',
          detail: `No path of actions leads here from "${start.name}", so applications will never arrive. Add an action from an earlier state that moves to it.`,
          fix: { label: 'Show State', run: () => goToState(s.id) },
        });
      }
      if (s.type !== 'end' && !outgoing(s.id).length) {
        issues.push({
          state: s.id,
          title: `"${s.name}" is a dead end`,
          todo: 'Connect this state to the next state.',
          detail: 'Applications that reach this state get stuck. Connect it to the next state, or make it an end state.',
          fix: { label: 'Connect', run: () => { goToState(s.id); startConnect(s.id); } },
        });
      }
    }
    for (const a of wf.actions) {
      if (!a.roles.length) {
        issues.push({
          action: a.id,
          title: `"${a.name}" has no roles`,
          todo: 'Add at least one role who can take this action.',
          detail: 'Nobody will be allowed to take this action. Add the roles that can, like VERIFIER or APPROVER.',
          fix: { label: 'Add Roles', run: () => select('action', a.id, { focusRoles: true }) },
        });
      }
    }
    return issues;
  }

  function goToState(id, opts) {
    const s = stateById(id);
    if (!s) return;
    select('state', id, opts);
    ensureVisible(s);
  }

  const WARN_ICON = 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z';

  /** Warning-style box above the name: the essentials this state or action still needs. */
  /* The essentials for a state or action, each with whether it is done yet.
     Same requirements as the issue list; shown as tick items. */
  function essentials(kind, id) {
    const pending = new Set(validate().filter((i) => (kind === 'state' ? i.state === id : i.action === id) && i.todo).map((i) => i.todo));
    const item = (text) => ({ text, done: !pending.has(text) });
    if (kind === 'action') return [item('Add at least one role who can take this action.')];
    const st = stateById(id);
    if (!st) return []; // it was just deleted
    const list = [];
    if (st.type !== 'start') list.push(item('Connect an earlier state to this one.'));
    if (st.type !== 'end') list.push(item('Connect this state to the next state.'));
    if (pending.has('Give this state a name no other state uses.')) list.push(item('Give this state a name no other state uses.'));
    return list;
  }

  /** Box above the name listing what this state or action still needs. Items drop off
      as they are done; the box disappears when nothing is left. */
  function todoBox(kind, id) {
    const pending = essentials(kind, id).filter((i) => !i.done);
    if (!pending.length) return null;
    return el(
      'div',
      { class: 'todo-box', role: 'status' },
      el('strong', { class: 'todo-box__title' }, kind === 'state' ? 'Required for this state' : 'Required for this action'),
      el(
        'ul',
        { class: 'tick-list' },
        pending.map((i) =>
          el('li', { class: 'tick-item' }, el('span', { class: 'tick-item__arrow', 'aria-hidden': 'true' }, icon('M5 12h14M13 6l6 6-6 6', 16)), el('span', {}, i.text))
        )
      )
    );
  }

  function refreshTodoBox() {
    const body = $('.panel-body', inspector);
    if (!body || !selected) return;
    if (!(selected.kind === 'state' ? stateById(selected.id) : actionById(selected.id))) return;
    const next = todoBox(selected.kind, selected.id);
    const current = $('.todo-box', body);
    if (current && next) current.replaceWith(next);
    else if (current) current.remove();
    else if (next) body.prepend(next);
  }

  function issueCard(issue, { onFix } = {}) {
    const showFix = !!issue.fix;
    return el(
      'li',
      { class: 'issue' },
      el(
        'div',
        { class: 'issue__body' },
        el('strong', { class: 'issue__title' }, issue.title),
        el('p', { class: 'issue__detail' }, issue.detail),
        showFix
          ? el('button', { type: 'button', class: 'btn btn--secondary btn--small issue__fix', onClick: () => { onFix?.(); issue.fix.run(); } }, issue.fix.label)
          : null
      )
    );
  }

  function renderStats() {
    const issues = validate();
    if (!issues.length) issuesOpen = false;

    const issueLabel = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
    const health = !wf.states.length
      ? null
      : issues.length
        ? el(
            'button',
            {
              type: 'button',
              class: 'stats__health stats__health--warn',
              'aria-expanded': String(issuesOpen),
              'aria-controls': 'issuesPanel',
              title: 'See what needs fixing',
              onClick: (e) => {
                e.stopPropagation();
                issuesOpen = !issuesOpen;
                renderStats();
              },
            },
            icon(WARN_ICON, 14),
            `${issueLabel} in this workflow`,
            icon(issuesOpen ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6', 14)
          )
        : el('span', { class: 'stats__health stats__health--ok' }, icon('M5 12l5 5L20 7', 14), 'No issues');

    const closePanel = () => { issuesOpen = false; renderStats(); };

    statsEl.replaceChildren(...[
      el('span', { class: 'stat' }, el('strong', {}, wf.states.length), wf.states.length === 1 ? ' state' : ' states'),
      el('span', { class: 'stats__sep', 'aria-hidden': 'true' }),
      el('span', { class: 'stat' }, el('strong', {}, wf.actions.length), wf.actions.length === 1 ? ' action' : ' actions'),
      health ? el('span', { class: 'stats__sep', 'aria-hidden': 'true' }) : null,
      health,
      issuesOpen
        ? el(
            'div',
            { class: 'issues', id: 'issuesPanel', role: 'region', 'aria-label': 'Issues in this workflow', onClick: (e) => e.stopPropagation() },
            el(
              'div',
              { class: 'issues__head' },
              el('div', {}, el('h3', {}, `${issueLabel} in this workflow`), el('p', { class: 'muted' }, 'Fix these so the workflow runs as expected. You can still download the code.')),
              el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close issues', onClick: closePanel }, icon(ICONS.close, 16))
            ),
            el('ul', { class: 'issues__list' }, issues.map((i) => issueCard(i, { onFix: closePanel })))
          )
        : null,
    ].filter(Boolean));
  }


  /* ================= Inspector ================= */
  // The right panel only exists while a state or an action is selected; the
  // canvas takes the full width otherwise.
  function renderInspector(opts = {}) {
    if (tipOwner) hideTip();
    let content = null;
    if (selected?.kind === 'state' && stateById(selected.id)) content = statePanel(stateById(selected.id));
    else if (selected?.kind === 'action' && actionById(selected.id)) content = actionPanel(actionById(selected.id));

    const open = !!content;
    inspector.hidden = !open;
    $('.layout').classList.toggle('has-inspector', open);
    if (!open) {
      inspector.replaceChildren();
      return;
    }
    inspector.replaceChildren(...content);
    if (opts.focusName) {
      const input = $('[data-focus="name"]', inspector);
      input?.focus();
      input?.select();
    }
    if (opts.focusRoles) $('.role-check input', inspector)?.focus();
    if (opts.focusRole) $('[data-focus="role"]', inspector)?.focus();
    if (opts.focusRename) {
      const input = $('[data-focus="rename"]', inspector);
      input?.focus();
      input?.select();
    }
  }

  function panelHead(title, description, onClose) {
    return el(
      'div',
      { class: 'panel-head' },
      el('div', { class: 'panel-head__text' }, el('h2', {}, title), el('p', { class: 'panel-head__desc' }, description)),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close panel', title: 'Close', onClick: onClose }, icon(ICONS.close, 18))
    );
  }

  let fieldSeq = 0;
  function field(label, control, hint, { required = false } = {}) {
    const id = control.id || `f${fieldSeq++}`;
    control.id = id;
    if (required) control.setAttribute('aria-required', 'true');
    const hintEl = hint ? el('div', { class: 'field__hint', id: `${id}-hint` }, hint) : null;
    if (hintEl) control.setAttribute('aria-describedby', hintEl.id);
    return el(
      'div',
      { class: 'field' },
      el('label', { htmlFor: id }, label, required ? el('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
      control,
      hintEl
    );
  }

  /** Info "i" toggletip: the button reveals a short explanation under the heading. */
  /* Hover / focus tooltip for the "i" buttons (WCAG 1.4.13: it can be hovered,
     stays while hovered or focused, and Escape dismisses it). One shared
     element in <body>, positioned with fixed coordinates so the scrolling
     panel never clips it. */
  const tooltip = el('div', { class: 'tooltip', id: 'tooltip', role: 'tooltip', hidden: true });
  document.body.append(tooltip);
  let tipOwner = null;
  let tipHideTimer;

  function showTip(btn) {
    clearTimeout(tipHideTimer);
    tipOwner = btn;
    tooltip.textContent = btn.dataset.tip;
    tooltip.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = tooltip.offsetWidth;
    const h = tooltip.offsetHeight;
    const left = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8);
    const below = r.bottom + 8 + h < window.innerHeight;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${below ? r.bottom + 8 : r.top - h - 8}px`;
    tooltip.style.setProperty('--arrow-x', `${r.left + r.width / 2 - left}px`);
    tooltip.classList.toggle('is-above', !below);
  }
  function hideTip(delay = 0) {
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(() => {
      tooltip.hidden = true;
      tipOwner = null;
    }, delay);
  }
  tooltip.addEventListener('mouseenter', () => clearTimeout(tipHideTimer));
  tooltip.addEventListener('mouseleave', () => hideTip(100));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !tooltip.hidden) {
      e.stopPropagation();
      hideTip();
    }
  }, true);
  document.addEventListener('scroll', () => tipOwner && hideTip(), true);

  function infoTip(topic, text) {
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'info-btn',
        'aria-label': `About ${topic}`,
        'aria-describedby': 'tooltip',
        'data-tip': text,
        onMouseenter: () => showTip(btn),
        onMouseleave: () => hideTip(100),
        onFocus: () => showTip(btn),
        onBlur: () => hideTip(),
        onClick: () => (tooltip.hidden ? showTip(btn) : hideTip()),
      },
      icon('M12 16v-4M12 8h.01M22 12a10 10 0 11-20 0 10 10 0 0120 0z', 18)
    );
    return { btn, bubble: null };
  }

  /** A divided panel section with a blue heading, an optional count and an optional info tip. */
  function section(title, { count, info } = {}, ...children) {
    const tip = info ? infoTip(title, info) : null;
    return el(
      'section',
      { class: 'panel-section' },
      title
        ? el(
            'div',
            { class: 'panel-section__head' },
            el('h3', { class: 'panel-section__title' }, title, count !== undefined ? el('span', { class: 'count' }, count) : null),
            tip?.btn
          )
        : null,
      tip?.bubble,
      ...children
    );
  }

  function stepper(label, value, onChange, { min = 0, max = 9999 } = {}) {
    const id = `step${fieldSeq++}`;
    const input = el('input', {
      class: 'stepper__input',
      id,
      type: 'number',
      inputmode: 'numeric',
      min,
      max,
      value,
      onInput: (e) => onChange(clamp(Math.round(Number(e.target.value) || 0), min, max)),
      onBlur: (e) => { e.target.value = clamp(Math.round(Number(e.target.value) || 0), min, max); },
    });
    const bump = (d) => {
      const next = clamp((Number(input.value) || 0) + d, min, max);
      input.value = next;
      onChange(next);
    };
    return el(
      'div',
      { class: 'field' },
      el('label', { htmlFor: id }, label),
      el(
        'div',
        { class: 'stepper' },
        el('button', { type: 'button', class: 'stepper__btn', 'aria-label': `Decrease ${label}`, onClick: () => bump(-1) }, icon('M5 12h14', 16)),
        input,
        el('button', { type: 'button', class: 'stepper__btn', 'aria-label': `Increase ${label}`, onClick: () => bump(1) }, icon(ICONS.plus, 16))
      )
    );
  }

  const STATE_DESCRIPTION =
    'A state is a stage in the workflow. Set up its details and the rules that apply at this stage.';

  function statePanel(s) {
    const start = startState();
    const outs = outgoing(s.id);

    const nameInputEl = el('input', {
      class: 'input',
      type: 'text',
      value: s.name,
      'data-focus': 'name',
      autocomplete: 'off',
      onInput: (e) => {
        s.name = e.target.value;
        commit();
      },
      onBlur: (e) => {
        if (!e.target.value.trim()) {
          s.name = 'Untitled state';
          e.target.value = s.name;
          commit();
        }
      },
    });

    return [
      panelHead('State Properties', STATE_DESCRIPTION, () => select(null)),
      el(
        'div',
        { class: 'panel-body' },
        todoBox('state', s.id),
        section(null, {}, field('State Name', nameInputEl, null, { required: true })),
        // A start state only picks its form; the other settings apply to later states.
        ...(s.type === 'start'
          ? [formSection(s)]
          : [
              s.type !== 'end'
                ? section(
                    'SLA',
                    { info: 'Service level agreement (SLA): the maximum time work can stay in this state before it is marked overdue.' },
                    stepper('SLA Time Hours', s.slaHours, (v) => { s.slaHours = v; commit(); })
                  )
                : null,
              toggleSection(s, 'notify'),
              toggleSection(s, 'docs'),
              toggleSection(s, 'payment'),
              s.type !== 'end' ? escalationSection(s) : null,
            ]),
        el('div', { class: 'danger-zone' }, el('button', { type: 'button', class: 'btn btn--danger btn--block', onClick: () => deleteState(s.id) }, icon(ICONS.trash), 'Delete State'))
      ),
    ];
  }

  /** Empty list placeholder: a visible tray with an icon, so it reads as a container, not body text. */
  function emptyNote(text) {
    return el(
      'div',
      { class: 'empty-note' },
      el('span', { class: 'empty-note__icon', 'aria-hidden': 'true' }, icon('M4 13h4l2 3h4l2-3h4M4 13l2.5-7h11L20 13v5a1 1 0 01-1 1H5a1 1 0 01-1-1z', 18)),
      el('p', {}, text)
    );
  }

  /* ---------- Toggle sections: Notification, Document, Payment ----------
     Section heading -> grey card with a switch -> white "List of ..." card.
     UI only for now: Add appends a numbered row, edit renames it in place,
     delete removes it. */
  const TOGGLE_SECTIONS = {
    notify: {
      title: 'Notification',
      cardTitle: 'Send Notification',
      info: 'Automatic messages (SMS or email) sent to the people involved when something happens in this state.',
      listTitle: 'Notifications for this state',
      empty: 'Notification yet to be added',
      noun: 'Notification',
    },
    docs: {
      title: 'Document',
      cardTitle: 'Generate Document',
      info: 'Files the system creates automatically when work reaches this state, such as a receipt, certificate or letter.',
      listTitle: 'Documents for this state',
      empty: 'Document yet to be added',
      noun: 'Document',
    },
    payment: {
      title: 'Payment',
      cardTitle: 'Collect Payment',
      info: 'Fees collected at this state, such as an application or inspection fee. Work can be held here until they are paid.',
      listTitle: 'Payments for this state',
      empty: 'Payment yet to be added',
      noun: 'Payment',
    },
  };

  let renaming = null; // { stateId, key, id }

  const listOf = (s, key) => (s[key] ||= { enabled: false, items: [] });

  function toggleSection(s, key) {
    const cfg = TOGGLE_SECTIONS[key];
    const data = listOf(s, key);
    const tip = infoTip(cfg.title.toLowerCase(), cfg.info);
    const titleId = `${key}Title`;

    const toggle = el(
      'button',
      {
        type: 'button',
        class: 'switch',
        role: 'switch',
        'aria-checked': String(data.enabled),
        'aria-labelledby': titleId,
        onClick: () => {
          data.enabled = !data.enabled;
          commit();
          renderInspector();
          $(`[aria-labelledby="${titleId}"]`, inspector)?.focus();
        },
      },
      el('span', { class: 'switch__knob', 'aria-hidden': 'true' })
    );

    const isRenaming = (item) => renaming && renaming.stateId === s.id && renaming.key === key && renaming.id === item.id;

    const row = (item) => {
      if (isRenaming(item)) {
        const input = el('input', {
          class: 'logic-item__input',
          type: 'text',
          value: item.name,
          'aria-label': `${cfg.noun} name`,
          'data-focus': 'rename',
          autocomplete: 'off',
        });
        const finish = (keep) => {
          if (!renaming) return;
          if (keep) item.name = input.value.trim() || item.name;
          renaming = null;
          commit();
          renderInspector();
          $(`[data-item="${item.id}"] .logic-item__btn`, inspector)?.focus();
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
        return el('li', { class: 'logic-item is-editing', 'data-item': item.id }, input);
      }
      return el(
        'li',
        { class: 'logic-item', 'data-item': item.id },
        el('span', { class: 'logic-item__name' }, item.name),
        el('button', {
          type: 'button', class: 'logic-item__btn', 'aria-label': `Rename ${item.name}`, title: 'Edit',
          onClick: () => { renaming = { stateId: s.id, key, id: item.id }; renderInspector({ focusRename: true }); },
        }, icon('M4 20h16M14.5 4.5l3 3L9 16H6v-3z', 18)),
        el('button', {
          type: 'button', class: 'logic-item__btn', 'aria-label': `Delete ${item.name}`, title: 'Delete',
          onClick: () => confirmDelete(item.name, () => {
            data.items = data.items.filter((x) => x.id !== item.id);
            commit();
            renderInspector();
            toast(`${item.name} deleted`);
          }, '', { kind: cfg.noun }),
        }, icon('M5 4h14v16H5zM9.5 9.5l5 5M14.5 9.5l-5 5', 18))
      );
    };

    const add = () => {
      const used = new Set(data.items.map((i) => i.name));
      let n = data.items.length + 1;
      while (used.has(`${cfg.noun} ${n}`)) n++;
      data.items.push({ id: uid(key), name: `${cfg.noun} ${n}` });
      commit();
      renderInspector();
      $(`#${titleId}`, inspector)?.closest('.toggle-card')?.querySelector('.btn--secondary')?.focus();
    };

    return el(
      'section',
      { class: 'panel-section' },
      el('div', { class: 'panel-section__head' }, el('h3', { class: 'panel-section__title' }, cfg.title), tip.btn),
      tip.bubble,
      el(
        'div',
        { class: `toggle-card${data.enabled ? ' is-on' : ''}` },
        el('div', { class: 'toggle-card__head' }, el('h4', { class: 'toggle-card__title', id: titleId }, cfg.cardTitle), toggle),
        data.enabled
          ? el(
              'div',
              { class: 'inner-card' },
              el('div', { class: 'inner-card__head' }, el('h5', { class: 'inner-card__title' }, cfg.listTitle)),
              data.items.length ? el('ul', { class: 'logic-list' }, data.items.map(row)) : emptyNote(cfg.empty),
              el('button', { type: 'button', class: 'btn btn--secondary btn--block inner-card__add', onClick: add }, icon(ICONS.plus), `Add ${cfg.noun} to State`)
            )
          : null
      )
    );
  }

  /* ---------- Auto Escalation ----------
     When the SLA runs out, the system takes one of this state's actions on its own.
     Two white containers inside the toggle card: the action, and the time. */
  const escalationOf = (s) => (s.escalation ||= { enabled: false, actionId: '', hours: s.slaHours || 24 });

  function escalationSection(s) {
    const esc = escalationOf(s);
    const outs = outgoing(s.id);
    if (esc.actionId && !outs.some((a) => a.id === esc.actionId)) esc.actionId = '';
    const tip = infoTip('auto escalation', 'If nobody acts within the set time, the system takes the chosen action on its own, so work never gets stuck in this state.');

    const toggle = el(
      'button',
      {
        type: 'button',
        class: 'switch',
        role: 'switch',
        'aria-checked': String(esc.enabled),
        'aria-labelledby': 'escTitle',
        onClick: () => {
          esc.enabled = !esc.enabled;
          commit();
          renderInspector();
          $('[aria-labelledby="escTitle"]', inspector)?.focus();
        },
      },
      el('span', { class: 'switch__knob', 'aria-hidden': 'true' })
    );

    const actionSelect = el(
      'select',
      {
        class: 'select select--plain',
        id: 'escAction',
        disabled: !outs.length,
        onChange: (e) => { esc.actionId = e.target.value; commit(); },
      },
      el('option', { value: '', selected: !esc.actionId }, outs.length ? 'Select an action' : 'No actions yet'),
      outs.map((a) => el('option', { value: a.id, selected: esc.actionId === a.id }, a.name))
    );

    return el(
      'section',
      { class: 'panel-section' },
      el('div', { class: 'panel-section__head' }, el('h3', { class: 'panel-section__title' }, 'Auto Escalation'), tip.btn),
      el(
        'div',
        { class: `toggle-card${esc.enabled ? ' is-on' : ''}` },
        el('div', { class: 'toggle-card__head' }, el('h4', { class: 'toggle-card__title', id: 'escTitle' }, 'Escalate Automatically'), toggle),
        esc.enabled
          ? el(
              'div',
              { class: 'esc-fields' },
              el(
                'div',
                { class: 'inner-card' },
                field('Escalate via action', actionSelect)
              ),
              el(
                'div',
                { class: 'inner-card' },
                stepper('Escalate After (Hours)', esc.hours, (v) => { esc.hours = v; commit(); }, { min: 1 })
              )
            )
          : null
      )
    );
  }

  /** Config entries for the enabled toggle sections of a state. */
  function toggleConfig(s) {
    const out = {};
    const on = (key) => s[key]?.enabled && s[key].items.length;
    if (on('docs')) out.generatedDocuments = s.docs.items.map((i) => ({ documentType: toCode(i.name) }));
    if (on('payment')) out.payments = s.payment.items.map((i) => ({ name: i.name }));
    if (on('notify')) out.notifications = s.notify.items.map((i) => ({ name: i.name }));
    const esc = s.escalation;
    const escAction = esc?.enabled && actionById(esc.actionId);
    if (escAction) out.autoEscalation = { action: toCode(escAction.name), afterMs: esc.hours * HOUR_MS };
    return out;
  }

  const ROLE_LABELS = {
    CITIZEN: 'Citizen',
    EMPLOYEE: 'Employee',
    VERIFIER: 'Verifier',
    APPROVER: 'Approver',
    FIELD_INSPECTOR: 'Field inspector',
    SUPERVISOR: 'Supervisor',
    ADMIN: 'Admin',
  };

  let addingRole = false;

  /** Roles as a checklist inside a grey card and white inner card (no switch).
      Roles added here are kept on the workflow, so every action can use them. */
  function rolesCard(a) {
    const custom = (wf.customRoles ||= []);
    const all = [...new Set([...ROLE_SUGGESTIONS, ...custom, ...a.roles])];

    const roleLabel = (r) => ROLE_LABELS[r] || r.charAt(0) + r.slice(1).toLowerCase().replace(/_/g, ' ');

    let addArea;
    if (addingRole) {
      const input = el('input', { class: 'logic-item__input', type: 'text', placeholder: 'Role name, for example Clerk', 'aria-label': 'New role name', 'data-focus': 'role', autocomplete: 'off' });
      const finish = (keep) => {
        if (!addingRole) return;
        addingRole = false;
        const code = toCode(input.value);
        if (keep && code) {
          if (!all.includes(code)) custom.push(code);
          if (!a.roles.includes(code)) a.roles = [...a.roles, code];
          commit();
          toast(`${roleLabel(code)} added`);
        }
        renderInspector();
        $('.role-add', inspector)?.focus();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
      addArea = el('div', { class: 'logic-item is-editing' }, input);
    } else {
      addArea = el(
        'button',
        { type: 'button', class: 'btn btn--secondary btn--block inner-card__add role-add', onClick: () => { addingRole = true; renderInspector({ focusRole: true }); } },
        icon(ICONS.plus),
        'Add Role'
      );
    }
    return el(
      'div',
      { class: 'inner-card inner-card--muted' },
        el('div', { class: 'inner-card__head' }, el('h5', { class: 'inner-card__title', id: 'rolesListTitle' }, 'Roles for this action')),
        el(
          'ul',
          { class: 'role-list', role: 'group', 'aria-labelledby': 'rolesListTitle' },
          all.map((r) =>
            el(
              'li',
              {},
              el(
                'label',
                { class: 'role-check' },
                el('input', {
                  type: 'checkbox',
                  value: r,
                  checked: a.roles.includes(r),
                  onChange: (e) => {
                    a.roles = e.target.checked ? [...a.roles, r] : a.roles.filter((x) => x !== r);
                    commit();
                    renderInspector();
                    $(`.role-check input[value="${r}"]`, inspector)?.focus();
                  },
                }),
                roleLabel(r)
              )
            )
          )
        ),
        addArea
    );
  }

  const ACTION_SETTINGS = [
    { key: 'comments', title: 'Add comments', desc: 'Users can add remarks or notes while taking this action.' },
    { key: 'delegate', title: 'Delegate step', desc: 'This step can be delegated to another role or user.' },
    { key: 'editApplication', title: 'Edit application', desc: 'Users with access to this action can edit the application after taking it.' },
  ];

  function actionSettingsCard(a) {
    const settings = (a.settings ||= {});
    return el(
      'ul',
      { class: 'settings-card' },
      ACTION_SETTINGS.map((opt) => {
        const titleId = `set-${opt.key}`;
        const descId = `${titleId}-desc`;
        return el(
          'li',
          { class: 'setting' },
          el('div', { class: 'setting__text' },
            el('span', { class: 'setting__title', id: titleId }, opt.title),
            el('span', { class: 'setting__desc', id: descId }, opt.desc)),
          el(
            'button',
            {
              type: 'button',
              class: 'switch',
              role: 'switch',
              'aria-checked': String(!!settings[opt.key]),
              'aria-labelledby': titleId,
              'aria-describedby': descId,
              onClick: (e) => {
                settings[opt.key] = !settings[opt.key];
                e.currentTarget.setAttribute('aria-checked', String(settings[opt.key]));
                commit();
              },
            },
            el('span', { class: 'switch__knob', 'aria-hidden': 'true' })
          )
        );
      })
    );
  }

  /* ---------- Form (start state only) ----------
     Every start state comes with its form, so it is simply shown: no add,
     edit or delete. */
  const DEFAULT_FORM_NAME = 'Application form';

  function formSection(s) {
    const form = (s.form ||= { id: uid('f'), name: DEFAULT_FORM_NAME });
    return section(
      'Form',
      { info: 'The form people fill in to start this workflow.' },
      el(
        'div',
        { class: 'inner-card inner-card--muted' },
        el('div', { class: 'inner-card__head' }, el('h5', { class: 'inner-card__title' }, 'Form for this state')),
        el('ul', { class: 'logic-list' }, el('li', { class: 'logic-item' }, el('span', { class: 'logic-item__name' }, form.name)))
      )
    );
  }

  /* ---------- Checklist on an action ----------
     Same pattern as Notification: heading -> grey card with a switch -> white
     list card. Add puts in "Checklist 1" straight away (no dropdown); edit
     renames it in place; delete removes it. Only one checklist per action, so
     the Add button is hidden while one exists. */
  let renamingChecklist = false;

  function checklistSection(a) {
    const data = (a.checklist ||= { enabled: false, item: null });
    const tip = infoTip('checklist', 'A list of checks the assigned roles must confirm before they can take this action.');

    const toggle = el(
      'button',
      {
        type: 'button',
        class: 'switch',
        role: 'switch',
        'aria-checked': String(data.enabled),
        'aria-labelledby': 'checklistTitle',
        onClick: () => {
          data.enabled = !data.enabled;
          renamingChecklist = false;
          commit();
          renderInspector();
          $('[aria-labelledby="checklistTitle"]', inspector)?.focus();
        },
      },
      el('span', { class: 'switch__knob', 'aria-hidden': 'true' })
    );

    let body;
    if (data.item && renamingChecklist) {
      const input = el('input', { class: 'logic-item__input', type: 'text', value: data.item.name, 'aria-label': 'Checklist name', 'data-focus': 'rename', autocomplete: 'off' });
      const finish = (keep) => {
        if (!renamingChecklist) return;
        renamingChecklist = false;
        if (keep) data.item.name = input.value.trim() || data.item.name;
        commit();
        renderInspector();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
      body = el('ul', { class: 'logic-list' }, el('li', { class: 'logic-item is-editing' }, input));
    } else if (data.item) {
      const item = data.item;
      body = el(
        'ul',
        { class: 'logic-list' },
        el(
          'li',
          { class: 'logic-item' },
          el('span', { class: 'logic-item__name' }, item.name),
          el('button', {
            type: 'button', class: 'logic-item__btn', 'aria-label': `Rename ${item.name}`, title: 'Edit',
            onClick: () => { renamingChecklist = true; renderInspector({ focusRename: true }); },
          }, icon('M4 20h16M14.5 4.5l3 3L9 16H6v-3z', 18)),
          el('button', {
            type: 'button', class: 'logic-item__btn', 'aria-label': `Delete ${item.name}`, title: 'Delete',
            onClick: () => confirmDelete(item.name, () => {
              data.item = null;
              commit();
              renderInspector();
              $('[data-add="checklist"]', inspector)?.focus();
              toast(`${item.name} deleted`);
            }, '', { kind: 'Checklist' }),
          }, icon('M5 4h14v16H5zM9.5 9.5l5 5M14.5 9.5l-5 5', 18))
        )
      );
    } else {
      body = emptyNote('Checklist yet to be added');
    }

    return el(
      'section',
      { class: 'panel-section' },
      el('div', { class: 'panel-section__head' }, el('h3', { class: 'panel-section__title' }, 'Checklist'), tip.btn),
      el(
        'div',
        { class: `toggle-card${data.enabled ? ' is-on' : ''}` },
        el('div', { class: 'toggle-card__head' }, el('h4', { class: 'toggle-card__title', id: 'checklistTitle' }, 'Attach Checklist'), toggle),
        data.enabled
          ? el(
              'div',
              { class: 'inner-card' },
              el('div', { class: 'inner-card__head' }, el('h5', { class: 'inner-card__title' }, 'Checklist for this action')),
              body,
              !data.item
                ? el('button', {
                    type: 'button', class: 'btn btn--secondary btn--block inner-card__add', 'data-add': 'checklist',
                    onClick: () => {
                      data.item = { id: uid('c'), name: 'Checklist 1' };
                      commit();
                      renderInspector();
                      toast('Checklist 1 added');
                    },
                  }, icon(ICONS.plus), 'Add Checklist to Action')
                : null
            )
          : null
      )
    );
  }

  function actionPanel(a) {
    const nameEl = el('input', {
      class: 'input',
      type: 'text',
      value: a.name,
      'data-focus': 'name',
      autocomplete: 'off',
      onInput: (e) => {
        a.name = e.target.value;
        commit();
      },
      onBlur: (e) => {
        if (!e.target.value.trim()) {
          a.name = 'Untitled action';
          e.target.value = a.name;
          commit();
        }
      },
    });


    return [
      panelHead('Action Properties', 'An action moves the workflow from one state to the next. Set up its details, who can take it, and what is required when it is taken.', () => select(null)),
      el(
        'div',
        { class: 'panel-body' },
        todoBox('action', a.id),
        section(null, {}, field('Action Name', nameEl, null, { required: true })),
        section(
          'Roles',
          { info: 'Roles are the permissions given to users that allow them to take this action. Only users with these roles will see it.' },
          rolesCard(a)
        ),
        checklistSection(a),
        section(
          'Action Settings',
          { info: 'Extra permissions that control what people can do when they take this action.' },
          actionSettingsCard(a)
        ),
        el('div', { class: 'danger-zone' }, el('button', { type: 'button', class: 'btn btn--danger btn--block', onClick: () => deleteAction(a.id) }, icon(ICONS.trash), 'Delete Action'))
      ),
    ];
  }

  /* ================= Pointer interaction ================= */
  let gesture = null;

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    issuesOpen && closeIssues();
    const handle = e.target.closest('.node__handle');
    const node = e.target.closest('.node');
    const edge = e.target.closest('.edge');
    if (e.target.closest('.edge-label, .empty')) return;

    if (handle && node) {
      e.preventDefault();
      gesture = { kind: 'connect', id: node.dataset.id, sx: e.clientX, sy: e.clientY, moved: false };
    } else if (node) {
      const s = stateById(node.dataset.id);
      gesture = { kind: 'node', id: s.id, sx: e.clientX, sy: e.clientY, ox: s.x, oy: s.y, moved: false, el: node };
    } else if (edge) {
      select('action', edge.dataset.id);
    } else {
      gesture = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!gesture) {
      if (connectFrom) drawGhost(connectFrom, e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - gesture.sx;
    const dy = e.clientY - gesture.sy;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    gesture.moved = true;

    if (gesture.kind === 'pan') {
      viewport.classList.add('is-panning');
      view.x = gesture.ox + dx;
      view.y = gesture.oy + dy;
      applyView();
    } else if (gesture.kind === 'node') {
      const s = stateById(gesture.id);
      s.x = snap(gesture.ox + dx / view.zoom);
      s.y = snap(gesture.oy + dy / view.zoom);
      gesture.el.classList.add('is-dragging');
      gesture.el.style.left = `${s.x}px`;
      gesture.el.style.top = `${s.y}px`;
      renderEdges();
    } else if (gesture.kind === 'connect') {
      drawGhost(gesture.id, e.clientX, e.clientY);
      nodesLayer.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'));
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
      if (over && over.dataset.id !== gesture.id) over.classList.add('is-drop-target');
    }
  });

  window.addEventListener('pointerup', (e) => {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    viewport.classList.remove('is-panning');

    if (g.kind === 'pan') {
      if (!g.moved) {
        if (connectFrom) cancelConnect();
        else if (selected) select(null);
      }
    } else if (g.kind === 'node') {
      if (g.moved) {
        g.el.classList.remove('is-dragging');
        save();
        renderEdges();
      } else {
        activateNode(g.id);
      }
    } else if (g.kind === 'connect') {
      ghostEdge.setAttribute('hidden', '');
      if (g.moved) {
        const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
        if (over && over.dataset.id !== g.id) finishConnect(g.id, over.dataset.id);
        else renderCanvas();
      } else {
        startConnect(g.id);
      }
    }
  });

  function activateNode(id) {
    if (connectFrom && connectFrom !== id) finishConnect(connectFrom, id);
    else if (connectFrom === id) cancelConnect();
    else select('state', id);
  }

  function startConnect(id) {
    const s = stateById(id);
    if (!s) return;
    if (s.type === 'end') {
      toast('End states close the workflow, so no actions can leave them.');
      return;
    }
    connectFrom = id;
    renderCanvas();
  }

  function cancelConnect() {
    connectFrom = null;
    ghostEdge.setAttribute('hidden', '');
    renderCanvas();
  }

  function finishConnect(fromId, toId) {
    connectFrom = null;
    ghostEdge.setAttribute('hidden', '');
    const a = addAction(fromId, toId);
    if (a) {
      select('action', a.id, { focusName: true });
      toast(`Connected. Name the action and add roles.`);
    } else {
      renderCanvas();
    }
  }

  function drawGhost(fromId, clientX, clientY) {
    const s = stateById(fromId);
    if (!s) return;
    const p = toWorld(clientX, clientY);
    const sx = s.x + NODE_W;
    const sy = s.y + NODE_H / 2;
    const c = Math.max(40, Math.abs(p.x - sx) / 2);
    ghostEdge.setAttribute('d', `M${sx},${sy} C${sx + c},${sy} ${p.x - c},${p.y} ${p.x},${p.y}`);
    ghostEdge.removeAttribute('hidden');
  }

  viewport.addEventListener(
    'wheel',
    (e) => {
      // Scrolling over the guide scrolls the guide, not the canvas zoom.
      if (e.target.closest('.empty-guide') && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        if (e.ctrlKey || e.metaKey || !e.shiftKey) {
          const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
          zoomTo(view.zoom * factor, e.clientX, e.clientY);
          return;
        }
      }
      view.x -= e.deltaX;
      view.y -= e.deltaY;
      applyView();
    },
    { passive: false }
  );

  /* ================= Keyboard ================= */
  function onNodeKey(e, s) {
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateNode(s.id);
    } else if (moves[e.key]) {
      e.preventDefault();
      const step = e.shiftKey ? GRID * 5 : GRID * 2;
      s.x += moves[e.key][0] * step;
      s.y += moves[e.key][1] * step;
      commit();
    } else if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      startConnect(s.id);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteState(s.id);
    }
  }

  const isTyping = (t) => t.closest('input, textarea, select, [contenteditable]');

  document.addEventListener('keydown', (e) => {
    if ($('#configDialog').open || $('#helpDialog').open || deleteDialog.open) return;
    if (e.key === 'Escape') {
      if (connectFrom) cancelConnect();
      else if (issuesOpen) closeIssues();

      else if (selected && !isTyping(e.target)) select(null);
      return;
    }
    if (isTyping(e.target)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !e.target.closest('.node')) {
      e.preventDefault();
      if (selected.kind === 'action') deleteAction(selected.id);
      else deleteState(selected.id);
    } else if (e.key === '+' || e.key === '=') {
      if (!e.ctrlKey && !e.metaKey) zoomTo(view.zoom * ZOOM_STEP);
    } else if (e.key === '-') {
      if (!e.ctrlKey && !e.metaKey) zoomTo(view.zoom / ZOOM_STEP);
    } else if (e.key === '0' && e.shiftKey) {
      zoomToFit();
    }
  });

  function closeIssues() {
    issuesOpen = false;
    renderStats();
  }
  document.addEventListener('click', () => issuesOpen && closeIssues());

  /* ================= Palette ================= */
  document.querySelectorAll('.palette-item').forEach((btn) => {
    btn.addEventListener('click', () => addState(btn.dataset.type));
    btn.addEventListener('dragstart', (e) => {
      if (btn.dataset.type === 'start' && startState()) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('application/x-workflow-state', btn.dataset.type);
      e.dataTransfer.effectAllowed = 'copy';
    });
  });

  viewport.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-workflow-state')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    viewport.classList.add('is-drop');
  });
  viewport.addEventListener('dragleave', (e) => {
    if (!viewport.contains(e.relatedTarget)) viewport.classList.remove('is-drop');
  });
  viewport.addEventListener('drop', (e) => {
    const type = e.dataTransfer.getData('application/x-workflow-state');
    viewport.classList.remove('is-drop');
    if (!type) return;
    e.preventDefault();
    const p = toWorld(e.clientX, e.clientY);
    addState(type, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
  });

  /* ================= Toolbar / zoom buttons ================= */
  $('#zoomInBtn').addEventListener('click', () => zoomTo(view.zoom * ZOOM_STEP));
  $('#zoomOutBtn').addEventListener('click', () => zoomTo(view.zoom / ZOOM_STEP));
  $('#zoomLabel').addEventListener('click', () => zoomTo(1));
  $('#fitBtn').addEventListener('click', zoomToFit);
  // The empty canvas shows the same steps as the Help guide.
  $('#emptyState .empty-guide__body').append($('#helpDialog .help-steps').cloneNode(true));

  /* Canvas options menu. Clear canvas lives here rather than in a toolbar, so a
     workflow-wide destructive action can't be hit by a slip, and it can be undone. */
  const menuBtn = $('#canvasMenuBtn');
  const menu = $('#canvasMenu');
  function setMenu(open, { returnFocus = false } = {}) {
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    if (open) $('#clearBtn').focus();
    else if (returnFocus) menuBtn.focus();
  }
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenu(menu.hidden);
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      setMenu(false, { returnFocus: true });
    }
  });
  document.addEventListener('click', () => !menu.hidden && setMenu(false));

  $('#clearBtn').addEventListener('click', () => {
    if (!wf.states.length) {
      toast('The canvas is already empty.');
      return;
    }
    setMenu(false, { returnFocus: true });
    confirmDelete('canvas', () => {
      wf.states = [];
      wf.actions = [];
      connectFrom = null;
      commit();
      select(null);
      resetView();
      toast('Canvas cleared');
    }, `This removes all ${plural(wf.states.length, 'state')} and ${plural(wf.actions.length, 'action')}.`, {
      title: 'Proceed to clear canvas?',
      question: 'Are you sure you want to clear the canvas?',
      cta: 'Clear Canvas',
    });
  });


  function loadExample() {
    const s = (name, type, x, y, sla, description) => ({ id: uid('s'), name, type, x, y, slaHours: sla, description });
    const applied = s('Applied', 'start', 0, 160, 24, 'A citizen has filed a complaint.');
    const verify = s('Pending verification', 'intermediate', 320, 160, 48, 'A verifier checks the complaint details.');
    const approve = s('Pending approval', 'intermediate', 640, 160, 72, 'An approver reviews the verified complaint.');
    const resolved = s('Resolved', 'end', 960, 60, 0, 'The complaint is resolved and closed.');
    const rejected = s('Rejected', 'end', 960, 280, 0, 'The complaint is rejected and closed.');
    const a = (name, from, to, roles) => ({ id: uid('a'), name, description: '', from: from.id, to: to.id, roles });
    wf.states = [applied, verify, approve, resolved, rejected];
    wf.actions = [
      a('Submit', applied, verify, ['CITIZEN']),
      a('Verify', verify, approve, ['VERIFIER']),
      a('Send back', verify, applied, ['VERIFIER']),
      a('Approve', approve, resolved, ['APPROVER']),
      a('Reject', approve, rejected, ['APPROVER']),
    ];
    commit();
    select(null);
    resetView();
  }

  /* ================= View Configuration ================= */
  function buildConfig() {
    const ordered = [...wf.states].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
    return {
      BusinessServices: [
        {
          businessService: toCode(wf.name) || 'WORKFLOW',
          business: '',
          businessServiceSla: ordered.reduce((sum, s) => sum + (s.type === 'end' ? 0 : s.slaHours), 0) * HOUR_MS,
          states: ordered.map((s) => ({
            state: toCode(s.name),
            applicationStatus: toCode(s.name),
            description: s.description || '',
            sla: s.type === 'intermediate' ? s.slaHours * HOUR_MS : null,
            isStartState: s.type === 'start',
            isTerminateState: s.type === 'end',
            ...(s.type === 'start' ? { form: toCode(s.form?.name || DEFAULT_FORM_NAME) } : {}),
            ...toggleConfig(s),
            actions: outgoing(s.id).map((a) => ({
              action: toCode(a.name),
              nextState: toCode(stateById(a.to)?.name),
              roles: a.roles,
              allowComments: !!a.settings?.comments,
              isDelegatable: !!a.settings?.delegate,
              canEditApplication: !!a.settings?.editApplication,
              ...(a.checklist?.enabled && a.checklist.item ? { checklist: toCode(a.checklist.item.name) } : {}),
            })),
          })),
        },
      ],
    };
  }

  const escapeHtml = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function highlight(json) {
    return escapeHtml(json).replace(
      /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (m, str, colon, lit) => {
        if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
        if (lit) return `<span class="b">${m}</span>`;
        return `<span class="n">${m}</span>`;
      }
    );
  }

  const dialog = $('#configDialog');
  let configText = '';

  function openConfig() {
    configText = JSON.stringify(buildConfig(), null, 2);
    $('#configCode').innerHTML = highlight(configText);
    dialog.showModal();
  }

  $('#viewConfigBtn').addEventListener('click', openConfig);

  // Instructions to make a workflow
  const helpDialog = $('#helpDialog');
  $('#headerHelpBtn').addEventListener('click', () => helpDialog.showModal());
  helpDialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => helpDialog.close()));
  helpDialog.addEventListener('click', (e) => { if (e.target === helpDialog) helpDialog.close(); });
  dialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  $('#copyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(configText);
      toast('Code copied');
    } catch {
      toast('Could not copy. Select the code and copy it instead.');
    }
  });

  $('#downloadBtn').addEventListener('click', () => {
    const file = `${(toCode(wf.name) || 'workflow').toLowerCase()}-workflow.json`;
    const url = URL.createObjectURL(new Blob([configText], { type: 'application/json' }));
    const link = el('a', { href: url, download: file });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Downloaded ${file}`);
  });

  /* ================= Footer ================= */
  $('#backBtn').addEventListener('click', () => toast('This demo has no previous screen.'));
  $('#moduleBackBtn').addEventListener('click', () => toast('The module dashboard is not part of this demo.'));
  $('#guidesBtn').addEventListener('click', () => toast('Tutorials and Guides will open here.'));
  $('#saveBtn').addEventListener('click', () => {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(wf));
      $('#savedNote').hidden = false;
    } catch {
      toast('Could not save. Your browser is blocking storage.');
    }
  });

  /* ================= Toast ================= */
  let toastTimer;
  function toast(message, action) {
    const hide = () => toastEl.classList.remove('is-visible', 'has-action');
    toastEl.replaceChildren(el('span', {}, message));
    if (action) {
      toastEl.append(el('button', { type: 'button', class: 'toast__action', onClick: () => { hide(); action.run(); } }, action.label));
    }
    toastEl.classList.add('is-visible');
    toastEl.classList.toggle('has-action', !!action);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hide, action ? 8000 : 2800);
  }

  /* ================= Init ================= */
  renderCanvas();
  renderStats();
  renderInspector();
  applyView();
  requestAnimationFrame(resetView);
  window.addEventListener('resize', applyView);
})();
