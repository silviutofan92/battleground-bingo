/*
 * Battleground UI: a full-screen overlay that plays one BattleEngine battle.
 * Load battle/engine.js and battle/battle.css first. The only global this file
 * defines is window.Battleground:
 *
 *   Battleground.open({ allyImg, enemyImg, onClose, seed })
 *
 * onClose({ result, rounds }) fires exactly once, with result 'ally', 'enemy'
 * or 'abandoned' (closed before the current battle ended).
 */
(function () {
  'use strict';

  var SQRT3 = Math.sqrt(3);
  // Per action: a short pause, a move or projectile tween, then a hit flash.
  // At most 360ms plus one frame, inside the 400ms budget.
  var TIMING = { aiDelay: 40, move: 190, shot: 140, blast: 180, hit: 130, quiet: 200, still: 320 };
  // Space taken by the header, log and button bar (mirrors battle.css).
  var CHROME = { w: 6, h: 176, heroRow: 23, outerPad: 24, frameMaxW: 1280, frameMaxH: 920 };
  var SKILL_LEVELS = ['none', 'basic', 'advanced', 'expert'];
  var COLORS = {
    deep: '#0B2026', panel: '#1B3139', gold: '#F5B735', amber: '#E6811A',
    allyDark: '#BA2C03', ally: '#E95707', enemyDark: '#054E64', enemy: '#197D84'
  };
  // Unit icons come from the host as monochrome SVG strings (no emoji).
  var ICON_TINT = { ally: '#FFF4E0', enemy: '#E8FFF8' };
  var ICON_ALIASES = { archers: 'genieArchers', knights: 'catalogKnights', cavalry: 'lakeflowCavalry' };
  var FONT = 'system-ui, sans-serif';

  /* ------------------------------------------------ pure layout maths */
  // Board units: hex radius 1, pointy-top, the board's top-left at (0, 0).

  function boardSize(cols, rows) {
    return { w: SQRT3 * (cols + 0.5), h: 1.5 * (rows - 1) + 2 };
  }

  function hexCenter(q, r) {
    return { x: SQRT3 * (q + r / 2) + SQRT3 / 2, y: 1.5 * r + 1 };
  }

  function isPortrait(width, height) {
    return height > width;
  }

  // Fit the board into a width x height box. Portrait turns the board 90
  // degrees so the ally edge (column 0) is at the bottom.
  function computeLayout(width, height, portrait, cols, rows, opts) {
    opts = opts || {};
    var pad = opts.pad == null ? 6 : opts.pad;
    var maxK = opts.maxK || 72;
    var b = boardSize(cols, rows);
    var spanX = portrait ? b.h : b.w;
    var spanY = portrait ? b.w : b.h;
    var k = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY, maxK);
    if (!(k > 0)) k = 1;
    return {
      k: k, portrait: !!portrait, cols: cols, rows: rows, width: width, height: height,
      boardW: b.w, boardH: b.h,
      ox: (width - spanX * k) / 2, oy: (height - spanY * k) / 2
    };
  }

  function toScreen(L, x, y) {
    if (L.portrait) return { x: L.ox + y * L.k, y: L.oy + (L.boardW - x) * L.k };
    return { x: L.ox + x * L.k, y: L.oy + y * L.k };
  }

  function toBoard(L, sx, sy) {
    if (L.portrait) return { x: L.boardW - (sy - L.oy) / L.k, y: (sx - L.ox) / L.k };
    return { x: (sx - L.ox) / L.k, y: (sy - L.oy) / L.k };
  }

  function axialRound(q, r) {
    var x = q, z = r, y = -x - z;
    var rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    var dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    return { q: rx + 0, r: rz + 0 };
  }

  // Screen point to the axial hex under it (may be off the board).
  function hexAtPoint(L, sx, sy) {
    var b = toBoard(L, sx, sy);
    var px = b.x - SQRT3 / 2, py = b.y - 1;
    return axialRound((SQRT3 / 3) * px - py / 3, (2 / 3) * py);
  }

  function hexScreenCenter(L, q, r) {
    var c = hexCenter(q, r);
    return toScreen(L, c.x, c.y);
  }

  // Whole-viewport plan, used by the headless layout check. opts.hero adds
  // the hero line under the header.
  function planForViewport(vw, vh, cols, rows, opts) {
    var outer = vw >= 900 && vh >= 700 ? CHROME.outerPad : 0;
    var fw = Math.min(vw - 2 * outer, CHROME.frameMaxW);
    var fh = Math.min(vh - 2 * outer, CHROME.frameMaxH);
    var portrait = isPortrait(vw, vh);
    var chromeH = CHROME.h + (opts && opts.hero ? CHROME.heroRow : 0);
    var L = computeLayout(fw - CHROME.w, fh - chromeH, portrait, cols, rows);
    L.frame = { w: fw, h: fh };
    L.hexShort = SQRT3 * L.k; // flat-to-flat size of one hex in CSS pixels
    return L;
  }

  // Give a standalone SVG string a fill (and currentColor) plus an intrinsic
  // size, so it rasterises the same way in every browser. Null if not SVG.
  function tintSvg(svg, color) {
    var str = String(svg == null ? '' : svg);
    var m = /<svg\b[^>]*>/i.exec(str);
    if (!m) return null;
    var tag = m[0];
    var fillAttr = /(\sfill\s*=\s*)("[^"]*"|'[^']*')/i;
    tag = fillAttr.test(tag) ? tag.replace(fillAttr, '$1"' + color + '"') : tag.replace(/^<svg\b/i, '<svg fill="' + color + '"');
    if (!/\scolor\s*=/i.test(tag)) tag = tag.replace(/^<svg\b/i, '<svg color="' + color + '"');
    if (!/\sheight\s*=/i.test(tag)) tag = tag.replace(/^<svg\b/i, '<svg height="256"');
    if (!/\swidth\s*=/i.test(tag)) tag = tag.replace(/^<svg\b/i, '<svg width="256"');
    if (!/\sxmlns\s*=/i.test(tag)) tag = tag.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    return str.slice(0, m.index) + tag + str.slice(m.index + m[0].length);
  }

  var layout = {
    boardSize: boardSize,
    hexCenter: hexCenter,
    isPortrait: isPortrait,
    compute: computeLayout,
    toScreen: toScreen,
    toBoard: toBoard,
    hexAtPoint: hexAtPoint,
    hexScreenCenter: hexScreenCenter,
    planForViewport: planForViewport,
    heroText: heroText,
    tintSvg: tintSvg
  };

  /* ------------------------------------------------------- overlay */

  var current = null;
  var serial = 0;

  function el(tag, cls, text) {
    var node = window.document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function now() {
    return window.performance && window.performance.now ? window.performance.now() : new Date().getTime();
  }

  function hexKey(h) { return h.q + ',' + h.r; }

  // "Alex, level 4 Wizard · Att 2 Def 1 Pow 5 Kno 6" from the display fields
  // and the hero numbers the engine actually uses.
  function heroText(display, h) {
    var name = display.name != null ? String(display.name).trim().slice(0, 24) : '';
    var cls = display.className != null ? String(display.className).trim().slice(0, 20) : '';
    cls = cls ? cls.charAt(0).toUpperCase() + cls.slice(1) : '';
    var level = Math.floor(Number(display.level));
    var who = [isFinite(level) && level > 0 ? 'level ' + level : '', cls].filter(Boolean).join(' ');
    var lead = name && who ? name + ', ' + who : name || (who ? who.charAt(0).toUpperCase() + who.slice(1) : 'Your hero');
    return lead + ' \u00B7 Att ' + h.attack + ' Def ' + h.defense + ' Pow ' + h.power + ' Kno ' + h.knowledge;
  }

  function skillsText(h) {
    var parts = ['archery', 'offense', 'armorer', 'sorcery'].filter(function (k) { return h.skills[k] > 0; })
      .map(function (k) { return k.charAt(0).toUpperCase() + k.slice(1) + ' ' + SKILL_LEVELS[h.skills[k]]; });
    return parts.length ? 'Skills: ' + parts.join(', ') : 'No secondary skills yet';
  }

  function open(opts) {
    if (current) return;
    var E = window.BattleEngine;
    if (!E) throw new Error('Battleground: load battle/engine.js before battle/ui.js');
    current = startSession(E, opts || {});
  }

  function startSession(E, opts) {
    var doc = window.document;
    var body = doc.body || doc.documentElement;
    var prevFocus = doc.activeElement;
    var portrait = isPortrait(window.innerWidth || 0, window.innerHeight || 0);
    var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var uid = 'bg-dialog-' + (++serial);
    var timers = [];
    var raf = 0;
    var images = { ally: null, enemy: null };
    var icons = {};
    var arts = {};
    var hero = opts.hero && typeof opts.hero === 'object' ? opts.hero : null;
    var sound = opts.sound && typeof opts.sound === 'object' && typeof opts.sound.toggle === 'function' ? opts.sound : null;
    var battleNumber = Math.max(1, Math.floor(Number(opts.battleNumber)) || 1);
    var difficulty = opts.difficulty;
    var st = {
      closed: false, state: null, auto: false, busy: false, mode: 'normal',
      hover: null, hoverSig: '', pendingFireball: null, message: '', hint: '',
      anim: null, armed: false, armTimer: 0, cache: null, L: null, dpr: 1, down: null
    };

    /* ---- DOM ---- */
    var overlay = el('div', 'bg-overlay ' + (portrait ? 'bg-portrait' : 'bg-landscape'));
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', uid + '-title');
    var frame = el('div', 'bg-frame');
    frame.tabIndex = -1;

    var head = el('div', 'bg-head');
    var title = el('h2', 'bg-title', 'Battleground');
    title.id = uid + '-title';
    var status = el('p', 'bg-status');
    var roundBox = el('span', 'bg-round', 'Round 1');
    var closeX = el('button', 'bg-close', '×');
    closeX.type = 'button';
    closeX.setAttribute('aria-label', 'Close the battle');
    head.appendChild(title);
    head.appendChild(status);
    head.appendChild(roundBox);
    if (sound) {
      var soundBtn = el('button', 'bg-sound', sound.on ? 'Sound on' : 'Sound off');
      soundBtn.type = 'button';
      soundBtn.setAttribute('aria-pressed', String(!!sound.on));
      soundBtn.addEventListener('click', function () {
        var on;
        try { on = !!sound.toggle(); } catch (e) { on = soundBtn.getAttribute('aria-pressed') !== 'true'; }
        soundBtn.textContent = on ? 'Sound on' : 'Sound off';
        soundBtn.setAttribute('aria-pressed', String(on));
      });
      head.appendChild(soundBtn);
      overlay.classList.add('bg-has-sound');
    }
    head.appendChild(closeX);

    var heroLine = hero ? el('p', 'bg-hero') : null;

    var stage = el('div', 'bg-stage');
    var canvas = el('canvas', 'bg-canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Hex battlefield: your army in red, the enemy in teal.');
    stage.appendChild(canvas);

    var log = el('p', 'bg-log');
    log.setAttribute('aria-live', 'polite');

    var bar = el('div', 'bg-bar');
    function makeButton(label, toggle) {
      var b = el('button', 'bg-btn', label);
      b.type = 'button';
      if (toggle) b.setAttribute('aria-pressed', 'false');
      bar.appendChild(b);
      return b;
    }
    var btn = {
      wait: makeButton('Wait'),
      defend: makeButton('Defend'),
      fireball: makeButton('Fireball', true),
      auto: makeButton('Auto', true),
      retreat: makeButton('Retreat')
    };
    btn.retreat.classList.add('bg-btn-danger');
    var casts = null;
    if (hero) {
      casts = el('span', 'bg-casts');
      casts.setAttribute('aria-hidden', 'true');
      btn.fireball.appendChild(casts);
    }

    // The end-of-battle scroll is built only when the battle ends, so its
    // buttons never sit hidden in the page beforehand.
    var scrollWrap = null;

    frame.appendChild(head);
    if (heroLine) frame.appendChild(heroLine);
    frame.appendChild(stage);
    frame.appendChild(log);
    frame.appendChild(bar);
    overlay.appendChild(frame);
    body.appendChild(overlay);

    // Make the rest of the page inert while the dialog is open.
    var inerted = [];
    Array.prototype.slice.call(body.children).forEach(function (child) {
      if (child === overlay || child.hasAttribute('inert')) return;
      child.setAttribute('inert', '');
      inerted.push(child);
    });
    var rootStyle = doc.documentElement.style;
    var prevOverflow = rootStyle.overflow;
    rootStyle.overflow = 'hidden';

    var ctx = canvas.getContext ? canvas.getContext('2d') : null;

    /* ---- helpers ---- */
    function later(fn, ms) {
      var id = window.setTimeout(function () {
        timers = timers.filter(function (t) { return t !== id; });
        if (!st.closed) fn();
      }, ms);
      timers.push(id);
      return id;
    }

    function reduced() { return !!(motionQuery && motionQuery.matches); }

    function nameOf(s, count) {
      var n = count == null ? s.count : count;
      return n === 1 ? s.one : s.name;
    }

    function verb(count, base) { return count === 1 ? base + 's' : base; }

    function playerTurn() {
      var s = st.state;
      if (!s || s.result || st.busy || st.auto) return false;
      var me = E.activeStack(s);
      return !!me && me.side === 'ally';
    }

    function actionIndex() {
      if (st.cache && st.cache.state === st.state) return st.cache.idx;
      var idx = { moves: {}, attacks: {}, shots: {}, wait: false };
      E.legalActions(st.state).forEach(function (a) {
        if (a.type === 'move') idx.moves[hexKey(a.to)] = a;
        else if (a.type === 'attack') (idx.attacks[a.target] = idx.attacks[a.target] || []).push(a);
        else if (a.type === 'shoot') idx.shots[a.target] = a;
        else if (a.type === 'wait') idx.wait = true;
      });
      st.cache = { state: st.state, idx: idx };
      return idx;
    }

    // The action a tap at screen point p on hex h means, if any. Tapping an
    // enemy attacks it from the legal hex nearest to the tap, so the player
    // can pick the side (and aim the dragon's breath).
    function actionFor(h, p) {
      if (!E.onBoard(h.q, h.r)) return null;
      var idx = actionIndex();
      var target = E.stackAt(st.state, h.q, h.r);
      if (target && target.side === 'enemy') {
        if (idx.shots[target.id]) return idx.shots[target.id];
        var list = idx.attacks[target.id];
        if (!list || !list.length) return null;
        var b = toBoard(st.L, p.x, p.y), best = null, bestD = Infinity;
        list.forEach(function (a) {
          var c = hexCenter(a.from.q, a.from.r);
          var d = (c.x - b.x) * (c.x - b.x) + (c.y - b.y) * (c.y - b.y);
          if (d < bestD) { bestD = d; best = a; }
        });
        return best;
      }
      if (!target) return idx.moves[hexKey(h)] || null;
      return null;
    }

    // Start-of-battle line: difficulty, a grown host, and any deserters.
    function startLine(state) {
      var bits = [];
      var d = state.difficulty || 1;
      if (d < 1) bits.push('Battle ' + battleNumber + ': the Teal Dragon tests you.');
      else if (d > 1) bits.push('Battle ' + battleNumber + ': the host grows bolder.');
      var parts = [], grown = false;
      state.stacks.forEach(function (x) {
        if (x.side !== 'enemy' || x.count <= 1) return;
        parts.push(x.count + ' ' + x.name);
        if (E.UNITS[x.type] && x.count > E.UNITS[x.type].count) grown = true;
      });
      if (grown) bits.push('The Teal Dragon\'s host has grown to meet you: ' + joinNames(parts) + '.');
      var newFoes = state.stacks.filter(function (x) { return x.type === 'wyverns' || x.type === 'hydras'; }).map(function (x) { return x.name; });
      if (newFoes.length) bits.push('New foes join the host: ' + joinNames(newFoes) + '.');
      if (state.deserted > 0) bits.push('Your parley works: ' + state.deserted + (state.deserted === 1 ? ' creature deserts' : ' creatures desert') + ' the host.');
      return bits.join(' ');
    }

    // Sound hook: one call per shown event; the host's handler cannot break us.
    function emit(type, side, unit) {
      if (typeof opts.onEvent !== 'function') return;
      try { opts.onEvent({ type: type, side: side, unit: unit }); } catch (e) { /* ignore host errors */ }
    }

    function sideOf(state, id) {
      var x = id ? E.getStack(state, id) : null;
      return x ? x.side : null;
    }

    function emitEvents(events, state) {
      if (typeof opts.onEvent !== 'function') return;
      events.forEach(function (e) {
        if (e.type === 'turn') emit('turn', sideOf(state, e.stack), e.stack);
        else if (e.type === 'move') emit('move', sideOf(state, e.stack), e.stack);
        else if (e.type === 'attack') emit('attack', sideOf(state, e.stack), e.stack);
        else if (e.type === 'shot') emit('shoot', sideOf(state, e.stack), e.stack);
        else if (e.type === 'fireball') emit('fireball', e.side, null);
        else if (e.type === 'luck') emit('luck', sideOf(state, e.stack), e.stack);
        else if (e.type === 'morale') emit('morale', sideOf(state, e.stack), e.stack);
        else if (e.type === 'heal') emit('heal', sideOf(state, e.target), e.target);
        else if (e.type === 'damage') {
          if (e.kind === 'retaliation') emit('retaliate', sideOf(state, e.source), e.source);
          if (e.kind === 'breath') emit('breath', sideOf(state, e.source), e.source);
          emit('damage', sideOf(state, e.target), e.target);
          if (e.died) emit('death', sideOf(state, e.target), e.target);
        } else if (e.type === 'end') emit(e.result === 'ally' ? 'victory' : 'defeat', 'ally', null);
      });
    }

    function describeStack(s) {
      var bits = [];
      if (s.fly) bits.push('flies');
      if (s.shoot) bits.push('shoots');
      if (s.breath) bits.push('breathes fire');
      if (s.noRetaliation) bits.push('takes no retaliation');
      return (s.side === 'ally' ? 'Your ' : 'Enemy ') + s.count + ' ' + nameOf(s) +
        ': attack ' + s.att + ', defence ' + s.def + ', damage ' + s.dmgMin + '-' + s.dmgMax +
        ', health ' + s.hp + ' each, speed ' + s.speed + (bits.length ? ', ' + bits.join(', ') : '') + '.';
    }

    function fireballHint(h) {
      var hit = [], amounts = [];
      E.fireballArea(h).forEach(function (a) {
        var s = E.stackAt(st.state, a.q, a.r);
        if (!s) return;
        var dmg = E.fireballDamage(st.state, 'ally', s);
        hit.push((s.side === 'ally' ? 'your ' : '') + nameOf(s));
        amounts.push(dmg);
      });
      if (!hit.length) return 'Fireball here hits nothing.';
      var same = amounts.every(function (d) { return d === amounts[0]; });
      if (same) return 'Fireball here burns ' + hit.join(', ') + ' for ' + amounts[0] + ' each.';
      return 'Fireball here burns ' + hit.map(function (n, i) { return n + ' (' + amounts[i] + ')'; }).join(', ') + '.';
    }

    function hintFor(info) {
      if (info.kind === 'fireball') return fireballHint(info.hex);
      if (info.kind !== 'attack' && info.kind !== 'shoot') return '';
      var est = E.estimateAction(st.state, info.action);
      var t = E.getStack(st.state, info.action.target);
      if (!est || !t) return '';
      var range = est.min === est.max ? String(est.min) : est.min + '-' + est.max;
      var kills = est.killsMin === est.killsMax ? String(est.killsMin) : est.killsMin + '-' + est.killsMax;
      var note = est.penalty < 1 ? (info.kind === 'shoot' ? ' Long range: half damage.' : ' Shooters fight at half strength up close.') : '';
      return (info.kind === 'shoot' ? 'Shoot' : 'Attack') + ' the ' + nameOf(t) + ': ' + range + ' damage, ' + kills + ' perish.' + note;
    }

    function killText(t, kills, died) {
      if (kills <= 0) return '';
      if (died) return kills === 1 ? ' The last ' + t.one + ' perishes.' : ' The last ' + kills + ' ' + t.name + ' perish.';
      return kills === 1 ? ' 1 ' + t.one + ' perishes.' : ' ' + kills + ' ' + t.name + ' perish.';
    }

    function joinNames(list) {
      if (list.length < 2) return list.join('');
      return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
    }

    // One line of narration for an action's events.
    function narrate(events, before) {
      var counts = {};
      before.stacks.forEach(function (s) { counts[s.id] = s.count; });
      var out = '';
      var fire = [];
      var fireAmounts = [];
      var fireKills = '';
      events.forEach(function (e) {
        var src = e.source ? E.getStack(before, e.source) : null;
        var tgt = e.target && typeof e.target === 'string' ? E.getStack(before, e.target) : null;
        if (e.type === 'damage') {
          var kills = killText(tgt, e.kills, e.died);
          if (e.kind === 'fireball') {
            fire.push(nameOf(tgt, counts[tgt.id]));
            fireAmounts.push(e.amount);
            fireKills += kills;
          } else if (e.kind === 'breath') {
            out += ' The flames reach the ' + nameOf(tgt, counts[tgt.id]) + ' for ' + e.amount + '.' + kills;
          } else if (e.kind === 'retaliation') {
            var rc = counts[src.id];
            out += ' The ' + nameOf(src, rc) + ' ' + verb(rc, 'strike') + ' back for ' + e.amount + '.' + kills;
          } else {
            var c = counts[src.id];
            out += ' The ' + nameOf(src, c) + ' ' + verb(c, 'deal') + ' ' + e.amount + ' damage.' + kills;
          }
          counts[e.target] = e.left;
        } else if (e.type === 'wait') {
          out += ' The ' + nameOf(src || E.getStack(before, e.stack)) + ' ' + verb(counts[e.stack], 'wait') + '.';
        } else if (e.type === 'defend') {
          out += ' The ' + nameOf(E.getStack(before, e.stack)) + ' ' + verb(counts[e.stack], 'brace') + ' for the next blow.';
        } else if (e.type === 'retreat') {
          out += ' You sound the retreat.';
        }
      });
      if (fire.length) {
        var even = fireAmounts.every(function (d) { return d === fireAmounts[0]; });
        out = ' Fireball! It burns the ' + joinNames(fire) + (even ? ' for ' + fireAmounts[0] + ' each.' :
          ' for up to ' + Math.max.apply(null, fireAmounts) + '.') + fireKills + out;
      }
      else if (!out) {
        var mv = events.filter(function (e) { return e.type === 'move'; })[0];
        if (mv) {
          var m = E.getStack(before, mv.stack);
          out = ' The ' + nameOf(m) + ' ' + verb(m.count, 'advance') + '.';
        }
      }
      return out.trim();
    }

    /* ---- drawing ---- */
    function hexPath(q, r, scale) {
      var c = hexCenter(q, r);
      ctx.beginPath();
      for (var i = 0; i < 6; i++) {
        var ang = Math.PI / 180 * (60 * i - 30);
        var p = toScreen(st.L, c.x + Math.cos(ang) * scale, c.y + Math.sin(ang) * scale);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

    function unitPoint(s) {
      var a = st.anim;
      if (a && a.phase === 1 && a.mv && a.mv.stack === s.id) {
        var f = hexCenter(a.mv.from.q, a.mv.from.r), t = hexCenter(a.mv.to.q, a.mv.to.r), e = ease(a.p);
        return toScreen(st.L, f.x + (t.x - f.x) * e, f.y + (t.y - f.y) * e);
      }
      return hexScreenCenter(st.L, s.q, s.r);
    }

    function drawRock(o) {
      var c = hexScreenCenter(st.L, o.q, o.r), r = st.L.k * 0.62;
      var g = ctx.createRadialGradient(c.x - r * 0.3, c.y - r * 0.4, r * 0.1, c.x, c.y, r * 1.1);
      g.addColorStop(0, '#9A8F78');
      g.addColorStop(1, '#3A342B');
      var pts = [[-0.9, 0.35], [-0.72, -0.28], [-0.25, -0.72], [0.36, -0.66], [0.86, -0.18], [0.9, 0.42], [0.36, 0.68], [-0.42, 0.7]];
      ctx.beginPath();
      pts.forEach(function (pt, i) {
        var x = c.x + pt[0] * r, y = c.y + pt[1] * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(c.x - r * 0.2, c.y - r * 0.5);
      ctx.lineTo(c.x + r * 0.05, c.y - r * 0.05);
      ctx.lineTo(c.x - r * 0.1, c.y + r * 0.35);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke();
    }

    function drawImageCover(img, x, y, w, h) {
      var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      if (!iw || !ih) return;
      var scale = Math.max(w / iw, h / ih);
      var sw = w / scale, sh = h / scale;
      ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
    }

    // A small gold shield marks a defending stack.
    function drawShield(cx, cy, size) {
      var h = size / 2;
      ctx.beginPath();
      ctx.moveTo(cx - h, cy - h);
      ctx.lineTo(cx + h, cy - h);
      ctx.lineTo(cx + h, cy);
      ctx.quadraticCurveTo(cx + h, cy + h * 0.9, cx, cy + h * 1.3);
      ctx.quadraticCurveTo(cx - h, cy + h * 0.9, cx - h, cy);
      ctx.closePath();
      ctx.fillStyle = COLORS.gold;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#3A2809';
      ctx.stroke();
    }

    function drawUnit(s, active) {
      var p = unitPoint(s);
      var r = st.L.k * 0.72;
      var ally = s.side === 'ally';
      // Painted art first (unitImgs, then the dragon images), then the SVG
      // icon, then a plain disc with the first letter.
      var img = arts[s.type] || (s.type === 'redDragon' ? images.ally : s.type === 'tealDragon' ? images.enemy : null);

      ctx.beginPath();
      ctx.ellipse(p.x, p.y + r * 0.8, r * 0.78, r * 0.2, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fill();

      var g = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.35, r * 0.1, p.x, p.y, r);
      g.addColorStop(0, ally ? COLORS.ally : COLORS.enemy);
      g.addColorStop(1, ally ? COLORS.allyDark : COLORS.enemyDark);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      if (img) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.9, 0, Math.PI * 2);
        ctx.clip();
        drawImageCover(img, p.x - r * 0.9, p.y - r * 0.9, r * 1.8, r * 1.8);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.93, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(2, r * 0.12);
        ctx.strokeStyle = ally ? COLORS.ally : COLORS.enemy;
        ctx.stroke();
      } else if (icons[s.type]) {
        ctx.drawImage(icons[s.type], p.x - r * 0.64, p.y - r * 0.64, r * 1.28, r * 1.28);
      } else {
        // Plain disc with the unit's first letter.
        ctx.font = '700 ' + Math.round(r * 0.95) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = ICON_TINT[s.side];
        ctx.fillText(String(s.name || s.one || '?').charAt(0).toUpperCase(), p.x, p.y + r * 0.05);
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.lineWidth = active ? Math.max(3, r * 0.14) : Math.max(1.5, r * 0.06);
      ctx.strokeStyle = active ? COLORS.gold : 'rgba(245,183,53,0.6)';
      ctx.stroke();

      if (s.defending) drawShield(p.x - r * 0.72, p.y - r * 0.68, r * 0.44);

      // The stack-count box at the unit's feet.
      var txt = String(s.count);
      var fs = Math.max(11, Math.round(r * 0.46));
      ctx.font = '700 ' + fs + 'px ' + FONT;
      var w = Math.max(fs * 1.6, ctx.measureText(txt).width + fs * 0.8), h = fs * 1.35;
      var x = p.x + r * 0.98 - w, y = p.y + r * 0.58;
      roundRect(x, y, w, h, 3);
      ctx.fillStyle = ally ? '#5A1704' : '#03343D';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = COLORS.gold;
      ctx.stroke();
      ctx.fillStyle = '#FFE6A3';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(txt, x + w / 2, y + h / 2 + 1);
    }

    function drawShot(a) {
      var from = E.getStack(a.before, a.shot.stack), to = E.getStack(a.before, a.shot.target);
      if (!from || !to) return;
      var f = hexScreenCenter(st.L, from.q, from.r), t = hexScreenCenter(st.L, to.q, to.r), e = a.p;
      var x = f.x + (t.x - f.x) * e, y = f.y + (t.y - f.y) * e;
      ctx.beginPath();
      ctx.moveTo(f.x + (t.x - f.x) * Math.max(0, e - 0.18), f.y + (t.y - f.y) * Math.max(0, e - 0.18));
      ctx.lineTo(x, y);
      ctx.lineWidth = Math.max(2, st.L.k * 0.07);
      ctx.strokeStyle = 'rgba(245,183,53,0.8)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, st.L.k * 0.09), 0, Math.PI * 2);
      ctx.fillStyle = COLORS.gold;
      ctx.fill();
    }

    function drawFloaters(a) {
      var seen = {};
      a.damage.forEach(function (e) {
        var t = E.getStack(st.state, e.target);
        if (!t) return;
        var c = hexScreenCenter(st.L, t.q, t.r);
        var n = seen[e.target] = (seen[e.target] || 0) + 1;
        var y = c.y - st.L.k * (0.55 + 0.45 * a.p) - (n - 1) * st.L.k * 0.4;
        ctx.globalAlpha = 1 - a.p * 0.5;
        ctx.font = '800 ' + Math.max(13, Math.round(st.L.k * 0.42)) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText('-' + e.amount, c.x, y);
        ctx.fillStyle = e.kind === 'fireball' ? '#FFB347' : '#FFFFFF';
        ctx.fillText('-' + e.amount, c.x, y);
        ctx.globalAlpha = 1;
      });
    }

    function fireballArea() {
      if (st.mode !== 'fireball') return null;
      var h = st.pendingFireball || (st.hover && st.hover.kind === 'fireball' ? st.hover.hex : null);
      if (!h) return null;
      var set = {};
      E.fireballArea(h).forEach(function (a) { set[hexKey(a)] = true; });
      return set;
    }

    function render() {
      if (!ctx || !st.L || !st.state) return;
      var L = st.L, a = st.anim;
      var view = a && a.phase === 1 ? a.before : st.state;
      var idx = playerTurn() ? actionIndex() : null;
      var me = E.activeStack(view);
      var hover = st.hover;
      var fb = fireballArea();
      var blast = null;
      if (a && a.phase === 1 && a.fireball) {
        blast = {};
        a.fireball.area.forEach(function (h) { blast[hexKey(h)] = true; });
      }

      ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
      ctx.clearRect(0, 0, L.width, L.height);

      E.allHexes().forEach(function (h) {
        var key = hexKey(h);
        var col = E.toOffset(h.q, h.r).col;
        var fill = 'rgba(255,255,255,0.035)';
        if (col === 0) fill = 'rgba(233,87,7,0.08)';
        else if (col === L.cols - 1) fill = 'rgba(25,125,132,0.12)';
        if (idx && idx.moves[key]) fill = 'rgba(245,183,53,0.17)';
        if (me && me.q === h.q && me.r === h.r) fill = 'rgba(245,183,53,0.32)';
        if (hover && hover.kind === 'move' && hover.hexKey === key) fill = 'rgba(245,183,53,0.38)';
        if (hover && hover.fromKey === key) fill = 'rgba(245,183,53,0.45)';
        if (fb && fb[key]) fill = 'rgba(233,87,7,0.45)';
        if (blast && blast[key]) fill = 'rgba(233,87,7,' + (0.3 + 0.45 * Math.sin(Math.PI * a.p)).toFixed(3) + ')';
        hexPath(h.q, h.r, 0.95);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(245,183,53,0.26)';
        ctx.stroke();
      });

      if (idx) {
        view.stacks.forEach(function (s) {
          if (!s.alive || s.side !== 'enemy' || !(idx.shots[s.id] || idx.attacks[s.id])) return;
          hexPath(s.q, s.r, 0.88);
          ctx.lineWidth = Math.max(2, L.k * 0.07);
          ctx.strokeStyle = COLORS.amber;
          ctx.stroke();
        });
      }
      if (me) {
        hexPath(me.q, me.r, 0.9);
        ctx.lineWidth = Math.max(2, L.k * 0.08);
        ctx.strokeStyle = COLORS.gold;
        ctx.stroke();
      }

      view.obstacles.forEach(drawRock);
      view.stacks.forEach(function (s) { if (s.alive && s.id !== view.active) drawUnit(s, false); });
      if (me && me.alive) drawUnit(me, !a);

      if (hover && hover.fromKey) {
        var tgt = E.getStack(view, hover.action.target);
        var from = hexScreenCenter(L, hover.action.from.q, hover.action.from.r);
        var to = hexScreenCenter(L, tgt.q, tgt.r);
        var mx = from.x + (to.x - from.x) * 0.5, my = from.y + (to.y - from.y) * 0.5;
        var ang = Math.atan2(to.y - from.y, to.x - from.x), sz = L.k * 0.3;
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(sz, 0);
        ctx.lineTo(-sz * 0.7, -sz * 0.75);
        ctx.lineTo(-sz * 0.25, 0);
        ctx.lineTo(-sz * 0.7, sz * 0.75);
        ctx.closePath();
        ctx.fillStyle = COLORS.gold;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = COLORS.deep;
        ctx.stroke();
        ctx.restore();
      }
      if (a && a.phase === 1 && a.shot) drawShot(a);
      if (a && a.phase === 2) drawFloaters(a);
    }

    /* ---- HUD ---- */
    function updateLog() {
      log.textContent = st.hint || st.message;
    }

    function setEnabled(b, on) {
      b.setAttribute('aria-disabled', on ? 'false' : 'true');
    }

    function enabled(b) { return b.getAttribute('aria-disabled') !== 'true'; }

    function updateHud() {
      var s = st.state;
      var me = E.activeStack(s);
      var mine = playerTurn();
      roundBox.textContent = 'Round ' + s.round;
      if (s.result) status.textContent = s.result === 'ally' ? 'Victory' : 'Defeat';
      else if (me) status.textContent = (me.side === 'ally' ? 'Your turn: ' : 'Enemy turn: ') + nameOf(me) + (st.auto && me.side === 'ally' ? ' (auto)' : '');
      setEnabled(btn.wait, mine && actionIndex().wait);
      setEnabled(btn.defend, mine);
      setEnabled(btn.fireball, mine && s.spells.ally > 0);
      if (casts) {
        casts.textContent = String(s.spells.ally);
        btn.fireball.setAttribute('aria-label', 'Fireball, ' + s.spells.ally + (s.spells.ally === 1 ? ' cast' : ' casts') + ' left');
      }
      setEnabled(btn.auto, !s.result);
      setEnabled(btn.retreat, mine);
      btn.fireball.setAttribute('aria-pressed', String(st.mode === 'fireball'));
      btn.auto.setAttribute('aria-pressed', String(st.auto));
      if (!mine) disarm();
      updateLog();
    }

    function disarm() {
      if (!st.armed) return;
      st.armed = false;
      btn.retreat.textContent = 'Retreat';
      btn.retreat.classList.remove('bg-armed');
      if (st.armTimer) window.clearTimeout(st.armTimer);
      st.armTimer = 0;
    }

    function clearHover() {
      st.hover = null;
      st.hoverSig = '';
      st.hint = '';
    }

    /* ---- flow ---- */
    function newBattle(seed) {
      var s = typeof seed === 'number' && isFinite(seed) ? seed : Math.floor(Math.random() * 4294967296);
      st.state = E.createBattle({ seed: s, hero: hero || undefined, difficulty: difficulty });
      if (heroLine) {
        heroLine.textContent = heroText(hero, st.state.hero);
        heroLine.title = skillsText(st.state.hero);
      }
      st.auto = false;
      st.mode = 'normal';
      st.pendingFireball = null;
      st.anim = null;
      st.cache = null;
      clearHover();
      st.message = startLine(st.state) || 'Tap a lit hex to move, or an enemy to attack. Tap the side of an enemy you want to strike from.';
      removeScroll();
      emit('start', 'ally', null);
      var first = E.activeStack(st.state);
      if (first) emit('turn', first.side, first.id);
      step();
    }

    function step() {
      if (st.closed) return;
      var result = E.outcome(st.state);
      if (result) {
        st.busy = false;
        st.auto = false;
        updateHud();
        render();
        showEnd();
        return;
      }
      var me = E.activeStack(st.state);
      st.busy = me.side !== 'ally' || st.auto;
      updateHud();
      render();
      if (st.busy) later(aiTurn, TIMING.aiDelay);
    }

    function aiTurn() {
      var me = E.activeStack(st.state);
      if (!me) return;
      if (me.side === 'ally' && !st.auto) {
        step();
        return;
      }
      var action = E.aiAction(st.state);
      if (action) perform(action);
    }

    function perform(action) {
      if (st.closed || E.outcome(st.state) || !E.isLegal(st.state, action)) return;
      var before = st.state;
      var res = E.applyAction(before, action);
      st.state = res.state;
      emitEvents(res.events, res.state);
      st.mode = 'normal';
      st.pendingFireball = null;
      clearHover();
      disarm();
      st.message = narrate(res.events, before) || st.message;
      if (E.outcome(st.state)) {
        st.anim = null;
        st.busy = false;
        step();
        return;
      }
      st.busy = true;
      updateHud();
      animate(res.events, before, function () {
        st.busy = false;
        step();
      });
    }

    function animate(events, before, done) {
      var mv = null, shot = null, fire = null, dmg = [];
      events.forEach(function (e) {
        if (e.type === 'move' && !mv) mv = e;
        else if (e.type === 'shot') shot = e;
        else if (e.type === 'fireball') fire = e;
        else if (e.type === 'damage') dmg.push(e);
      });
      if (reduced()) {
        st.anim = null;
        render();
        later(done, TIMING.still);
        return;
      }
      var p1 = mv ? TIMING.move : shot ? TIMING.shot : fire ? TIMING.blast : 0;
      var p2 = dmg.length ? TIMING.hit : 0;
      if (!p1 && !p2) {
        st.anim = null;
        render();
        later(done, TIMING.quiet);
        return;
      }
      var a = st.anim = { before: before, mv: mv, shot: shot, fireball: fire, damage: dmg, phase: p1 ? 1 : 2, p: 0, start: now() };
      function frameStep() {
        raf = 0;
        if (st.closed) return;
        var t = now() - a.start;
        if (t < p1) {
          a.phase = 1;
          a.p = t / p1;
        } else if (t < p1 + p2) {
          a.phase = 2;
          a.p = (t - p1) / p2;
        } else {
          st.anim = null;
          render();
          done();
          return;
        }
        render();
        raf = window.requestAnimationFrame(frameStep);
      }
      raf = window.requestAnimationFrame(frameStep);
    }

    function applyNext(next) {
      if (next.hero && typeof next.hero === 'object') {
        hero = next.hero;
        if (!heroLine) {
          heroLine = el('p', 'bg-hero');
          frame.insertBefore(heroLine, stage);
        }
        if (!casts) {
          casts = el('span', 'bg-casts');
          casts.setAttribute('aria-hidden', 'true');
          btn.fireball.appendChild(casts);
        }
      }
      if (next.difficulty != null) difficulty = next.difficulty;
      if (next.battleNumber != null) battleNumber = Math.max(1, Math.floor(Number(next.battleNumber)) || 1);
      if (next.unitIcons) loadIcons(next.unitIcons);
      if (next.unitImgs) loadArts(next.unitImgs);
    }

    function removeScroll() {
      if (scrollWrap && scrollWrap.parentNode) scrollWrap.parentNode.removeChild(scrollWrap);
      scrollWrap = null;
    }

    function showEnd() {
      removeScroll();
      var s = st.state;
      var win = s.result === 'ally';
      var n = s.round;
      var rounds = n === 1 ? '1 round' : n + ' rounds';
      var text;
      if (win) text = 'The enemy host is scattered after ' + rounds + '. The field is yours.';
      else if (s.endReason === 'retreat') text = 'You sound the retreat in round ' + n + '. Regroup and ride again.';
      else if (s.endReason === 'cap') text = 'The battle drags on for ' + rounds + ' and your army withdraws.';
      else text = 'Your army falls in round ' + n + '. The Teal Dragon holds the field, for now.';
      scrollWrap = el('div', 'bg-scroll-wrap');
      var scroll = el('div', 'bg-scroll ' + (win ? 'bg-victory' : 'bg-defeat'));
      scroll.setAttribute('role', 'group');
      scroll.setAttribute('aria-labelledby', uid + '-result');
      var scrollTitle = el('h3', 'bg-scroll-title', win ? 'Victory!' : 'Defeat');
      scrollTitle.id = uid + '-result';
      var scrollActions = el('div', 'bg-scroll-actions');
      var againBtn = el('button', 'bg-btn bg-btn-primary', 'Play again');
      againBtn.type = 'button';
      var closeBtn = el('button', 'bg-btn', 'Close');
      closeBtn.type = 'button';
      againBtn.addEventListener('click', function () {
        // The page may hand over the next battle (a stronger hero, a bolder host).
        if (typeof opts.nextBattle === 'function') {
          var next = null;
          try { next = opts.nextBattle(); } catch (e) { next = null; }
          if (next && typeof next === 'object') applyNext(next);
        }
        newBattle();
        focusEl(frame);
      });
      closeBtn.addEventListener('click', close);
      scrollActions.appendChild(againBtn);
      scrollActions.appendChild(closeBtn);
      scroll.appendChild(scrollTitle);
      scroll.appendChild(el('p', 'bg-scroll-text', text));
      scroll.appendChild(el('p', 'bg-scroll-note', 'Battleground only: your bingo card is unchanged.'));
      scroll.appendChild(scrollActions);
      scrollWrap.appendChild(scroll);
      frame.appendChild(scrollWrap);
      focusEl(againBtn);
    }

    function focusEl(node) {
      try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); }
    }

    function close() {
      if (st.closed) return;
      st.closed = true;
      timers.forEach(function (id) { window.clearTimeout(id); });
      timers = [];
      if (st.armTimer) window.clearTimeout(st.armTimer);
      if (raf) window.cancelAnimationFrame(raf);
      doc.removeEventListener('keydown', onKey, true);
      if (resizeObserver) resizeObserver.disconnect();
      else window.removeEventListener('resize', resize);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      inerted.forEach(function (child) { child.removeAttribute('inert'); });
      rootStyle.overflow = prevOverflow;
      current = null;
      if (prevFocus && typeof prevFocus.focus === 'function' && doc.contains(prevFocus)) focusEl(prevFocus);
      var result = E.outcome(st.state) || 'abandoned';
      if (typeof opts.onClose === 'function') opts.onClose({ result: result, rounds: st.state.round });
    }

    /* ---- input ---- */
    function localPoint(ev) {
      var rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    function onKey(ev) {
      if (ev.key === 'Escape' || ev.key === 'Esc') {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      }
    }

    function onDown(ev) {
      if (ev.button > 0) return;
      st.down = { id: ev.pointerId, p: localPoint(ev), type: ev.pointerType };
    }

    function onUp(ev) {
      var d = st.down;
      st.down = null;
      if (!d || d.id !== ev.pointerId || !st.L) return;
      var p = localPoint(ev);
      if (Math.abs(p.x - d.p.x) > 16 || Math.abs(p.y - d.p.y) > 16) return;
      tap(p, ev.pointerType || d.type || 'mouse');
    }

    function onCancel() { st.down = null; }

    function onMove(ev) {
      if (ev.pointerType && ev.pointerType !== 'mouse') return;
      if (!st.L) return;
      var p = localPoint(ev);
      var h = hexAtPoint(st.L, p.x, p.y);
      var info = null;
      if (playerTurn() && E.onBoard(h.q, h.r)) {
        if (st.mode === 'fireball') {
          info = { kind: 'fireball', hex: h };
        } else {
          var action = actionFor(h, p);
          if (action) {
            info = { kind: action.type, action: action, hexKey: hexKey(h), fromKey: action.type === 'attack' ? hexKey(action.from) : null };
          }
        }
      }
      var sig = info ? info.kind + ':' + JSON.stringify(info.action || info.hex) : '';
      canvas.style.cursor = info ? 'pointer' : 'default';
      if (sig === st.hoverSig) return;
      st.hoverSig = sig;
      st.hover = info;
      st.hint = info ? hintFor(info) : '';
      updateLog();
      render();
    }

    function onLeave(ev) {
      if (ev.pointerType && ev.pointerType !== 'mouse') return;
      if (!st.hover && !st.hint) return;
      clearHover();
      updateLog();
      render();
    }

    function tap(p, pointerType) {
      if (!playerTurn()) return;
      var h = hexAtPoint(st.L, p.x, p.y);
      if (st.mode === 'fireball') {
        if (!E.onBoard(h.q, h.r)) {
          st.pendingFireball = null;
          render();
          return;
        }
        var pend = st.pendingFireball;
        if (pointerType === 'mouse' || (pend && pend.q === h.q && pend.r === h.r)) {
          perform({ type: 'fireball', target: { q: h.q, r: h.r } });
        } else {
          st.pendingFireball = h;
          st.hint = fireballHint(h) + ' Tap the same hex again to cast.';
          updateLog();
          render();
        }
        return;
      }
      var action = actionFor(h, p);
      if (action) {
        perform(action);
        return;
      }
      var s = E.onBoard(h.q, h.r) ? E.stackAt(st.state, h.q, h.r) : null;
      st.hint = s ? describeStack(s) : '';
      updateLog();
    }

    function resize() {
      if (st.closed) return;
      var w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      st.dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(w * st.dpr);
      canvas.height = Math.round(h * st.dpr);
      st.L = computeLayout(w, h, portrait, st.state.cols, st.state.rows);
      render();
    }

    /* ---- wiring ---- */
    closeX.addEventListener('click', close);
    btn.wait.addEventListener('click', function () {
      if (enabled(btn.wait) && playerTurn()) perform({ type: 'wait' });
    });
    btn.defend.addEventListener('click', function () {
      if (enabled(btn.defend) && playerTurn()) perform({ type: 'defend' });
    });
    btn.fireball.addEventListener('click', function () {
      if (!enabled(btn.fireball) || !playerTurn()) return;
      st.mode = st.mode === 'fireball' ? 'normal' : 'fireball';
      st.pendingFireball = null;
      clearHover();
      st.hint = st.mode === 'fireball' ? 'Fireball: pick a hex. It burns that hex and its six neighbours for ' +
        E.fireballDamage(st.state, 'ally') + ', friend or foe.' : '';
      updateHud();
      render();
    });
    btn.auto.addEventListener('click', function () {
      if (!enabled(btn.auto) || st.state.result) return;
      st.auto = !st.auto;
      st.mode = 'normal';
      st.pendingFireball = null;
      clearHover();
      if (!st.busy) step();
      else updateHud();
    });
    btn.retreat.addEventListener('click', function () {
      if (!enabled(btn.retreat) || !playerTurn()) return;
      if (!st.armed) {
        st.armed = true;
        btn.retreat.textContent = 'Confirm';
        btn.retreat.classList.add('bg-armed');
        st.hint = 'Retreating ends the battle as a defeat. Press Confirm to flee.';
        updateLog();
        st.armTimer = window.setTimeout(function () {
          disarm();
          if (st.hint.indexOf('Retreating') === 0) st.hint = '';
          updateLog();
        }, 4000);
        return;
      }
      disarm();
      perform({ type: 'retreat' });
    });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    doc.addEventListener('keydown', onKey, true);
    var resizeObserver = window.ResizeObserver ? new window.ResizeObserver(function () { resize(); }) : null;
    if (resizeObserver) resizeObserver.observe(stage);
    else window.addEventListener('resize', resize);

    function loadImage(url, key) {
      if (!url || typeof url !== 'string') return;
      var img = new window.Image();
      img.onload = function () {
        if (st.closed) return;
        images[key] = img;
        render();
      };
      img.onerror = function () { images[key] = null; };
      img.src = url;
    }
    // Rasterise each host icon once, tinted for its side.
    function loadIcons(map) {
      if (!map || typeof map !== 'object') return;
      Object.keys(map).forEach(function (key) {
        var id = ICON_ALIASES[key] || key;
        var unit = E.UNITS[id];
        var svg = unit && typeof map[key] === 'string' ? tintSvg(map[key], ICON_TINT[unit.side]) : null;
        if (!svg) return;
        var img = new window.Image();
        img.onload = function () {
          if (st.closed) return;
          icons[id] = img;
          render();
        };
        img.onerror = function () { icons[id] = null; };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      });
    }
    loadIcons(opts.unitIcons);
    // Painted unit art (unitImgs): loaded once; a failed load falls back silently.
    function loadArts(map) {
      if (!map || typeof map !== 'object') return;
      Object.keys(map).forEach(function (key) {
        var id = ICON_ALIASES[key] || key;
        var url = map[key];
        if (!E.UNITS[id] || typeof url !== 'string' || !url) return;
        var art = new window.Image();
        art.onload = function () {
          if (st.closed) return;
          arts[id] = art;
          render();
        };
        art.onerror = function () { arts[id] = null; };
        art.src = url;
      });
    }
    loadArts(opts.unitImgs);
    loadImage(opts.allyImg, 'ally');
    loadImage(opts.enemyImg, 'enemy');

    newBattle(opts.seed);
    resize();
    focusEl(frame);

    return { close: close };
  }

  window.Battleground = {
    open: open,
    isOpen: function () { return !!current; },
    close: function () { if (current) current.close(); },
    layout: layout
  };
}());
