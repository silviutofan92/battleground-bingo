/*
 * Battleground battle engine.
 *
 * A small turn-based hex battle in the spirit of classic fantasy strategy
 * games. Everything here is pure and deterministic: randomness comes from a
 * mulberry32 generator whose state lives inside the battle state, the state is
 * plain JSON, and applyAction never mutates its input.
 *
 * Board: axial hex coordinates (q, r) with pointy-top hexes laid out as an
 * "odd-r" rectangle of 9 columns (depth) by 7 rows (lanes), where
 * column = q + floor(r / 2). The ally deploys on column 0, the enemy on
 * column 8.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.BattleEngine = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var COLS = 9;
  var ROWS = 7;
  var ROUND_CAP = 60;        // reaching this round is a loss for the ally
  var FIREBALL_DAMAGE = 50;
  var LONG_RANGE = 6;        // shots beyond this many hexes do half damage
  var DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

  // Starting stats. Only the enemy counts were tuned for balance (from 1/8/8/6
  // to 1/10/10/14) against the frozen casual-player proxy in tests/proxy.mjs.
  var UNITS = {
    redDragon: { name: 'Red Dragon', one: 'Red Dragon', side: 'ally', count: 1,
      att: 19, def: 19, dmgMin: 40, dmgMax: 50, hp: 180, speed: 9, fly: true, breath: true },
    genieArchers: { name: 'Genie Archers', one: 'Genie Archer', side: 'ally', count: 10,
      att: 9, def: 5, dmgMin: 3, dmgMax: 5, hp: 15, speed: 5, shoot: true },
    catalogKnights: { name: 'Catalog Knights', one: 'Catalog Knight', side: 'ally', count: 6,
      att: 10, def: 12, dmgMin: 6, dmgMax: 9, hp: 35, speed: 5 },
    lakeflowCavalry: { name: 'Lakeflow Cavalry', one: 'Lakeflow Cavalier', side: 'ally', count: 2,
      att: 15, def: 15, dmgMin: 15, dmgMax: 25, hp: 100, speed: 7 },
    tealDragon: { name: 'Teal Dragon', one: 'Teal Dragon', side: 'enemy', count: 1,
      att: 18, def: 18, dmgMin: 40, dmgMax: 50, hp: 180, speed: 8, fly: true, breath: true },
    wraiths: { name: 'Wraiths', one: 'Wraith', side: 'enemy', count: 10,
      att: 7, def: 7, dmgMin: 3, dmgMax: 5, hp: 18, speed: 7, fly: true, noRetaliation: true },
    golems: { name: 'Golems', one: 'Golem', side: 'enemy', count: 10,
      att: 7, def: 10, dmgMin: 4, dmgMax: 5, hp: 30, speed: 3 },
    shades: { name: 'Shades', one: 'Shade', side: 'enemy', count: 14,
      att: 10, def: 8, dmgMin: 5, dmgMax: 7, hp: 25, speed: 5, shoot: true },
    // Optional ally army from hero.army. Machines never retaliate and do not
    // count as the army: the Ballista cannot move, the Tent never acts.
    archangels: { name: 'Archangels', one: 'Archangel', side: 'ally', count: 0,
      att: 30, def: 30, dmgMin: 50, dmgMax: 50, hp: 250, speed: 18, fly: true },
    blackKnights: { name: 'Black Knights', one: 'Black Knight', side: 'ally', count: 0,
      att: 16, def: 16, dmgMin: 15, dmgMax: 30, hp: 120, speed: 7 },
    ballista: { name: 'Ballista', one: 'Ballista', side: 'ally', count: 1,
      att: 10, def: 10, dmgMin: 30, dmgMax: 50, hp: 250, speed: 0, shoot: true, machine: true },
    firstAidTent: { name: 'First Aid Tent', one: 'First Aid Tent', side: 'ally', count: 1,
      att: 0, def: 0, dmgMin: 0, dmgMax: 0, hp: 75, speed: 0, machine: true, passive: true }
  };
  var TENT_HEAL = 50;

  // Deployment: allies on the left edge, enemies on the right edge.
  var LINEUP = [
    { type: 'catalogKnights', row: 0 },
    { type: 'redDragon', row: 2 },
    { type: 'genieArchers', row: 4 },
    { type: 'lakeflowCavalry', row: 6 },
    { type: 'golems', row: 0 },
    { type: 'shades', row: 2 },
    { type: 'tealDragon', row: 4 },
    { type: 'wraiths', row: 6 }
  ];

  /* ---------------------------------------------------------------- hero */

  // Hero skill tables as exact fractions [numerator, denominator], indexed by
  // skill level 0-3 (none, basic, advanced, expert). Level 0 is exactly 1.
  var ONE = [1, 1];
  var ARCHERY = [ONE, [11, 10], [5, 4], [3, 2]];   // ranged damage x1.1 / 1.25 / 1.5
  var OFFENSE = [ONE, [11, 10], [6, 5], [13, 10]]; // melee damage x1.1 / 1.2 / 1.3
  var ARMORER = [ONE, [19, 20], [9, 10], [17, 20]]; // damage taken x0.95 / 0.9 / 0.85
  var NAVIGATION = [ONE, [11, 10], [6, 5], [13, 10]]; // ally retaliation x1.1 / 1.2 / 1.3
  var DIPLOMACY = [ONE, [19, 20], [9, 10], [17, 20]]; // enemy counts kept after growth
  var CHANCE = [0, 5, 10, 15];       // percent: leadership (morale) and luck
  var LOGISTICS = [0, 1, 1, 2];      // ally speed
  var PATHFINDING = [0, 1, 2, 2];    // deploy columns forward
  var FIRST_AID = [0, 20, 40, 60];   // HP healed each round
  var WISDOM = [0, 1, 1, 2];         // extra Fireball casts
  var SCHOLAR = [0, 5, 10, 15];      // percent spell damage, added to sorcery
  var EAGLE_EYE = [6, 8, 10, 12];    // long-range penalty starts beyond this
  var ESTATES = [0, 2, 4, 6];        // extra Genie Archers
  var SKILL_KEYS = ['archery', 'offense', 'armorer', 'sorcery', 'leadership', 'luck', 'logistics', 'tactics',
    'pathfinding', 'firstAid', 'wisdom', 'scholar', 'eagleEye', 'diplomacy', 'estates', 'navigation'];

  function clampInt(v, lo, hi) {
    v = Math.floor(Number(v));
    if (!isFinite(v)) return lo;
    return Math.max(lo, Math.min(hi, v));
  }

  // Keep only the numbers the rules use: stats 0-15, skills 0-3, plus the
  // optional cheat army and buffs.
  function normalizeHero(h) {
    h = h && typeof h === 'object' ? h : {};
    var sk = h.skills && typeof h.skills === 'object' ? h.skills : {};
    var army = h.army && typeof h.army === 'object' ? h.army : {};
    var buffs = h.buffs && typeof h.buffs === 'object' ? h.buffs : {};
    var skills = {};
    SKILL_KEYS.forEach(function (k) { skills[k] = clampInt(sk[k], 0, 3); });
    return {
      attack: clampInt(h.attack, 0, 15),
      defense: clampInt(h.defense, 0, 15),
      power: clampInt(h.power, 0, 15),
      knowledge: clampInt(h.knowledge, 0, 15),
      skills: skills,
      army: {
        archangels: clampInt(army.archangels, 0, 99),
        blackKnights: clampInt(army.blackKnights, 0, 99),
        ballista: !!army.ballista,
        firstAidTent: !!army.firstAidTent
      },
      buffs: {
        morale: clampInt(buffs.morale, 0, 3),
        luck: clampInt(buffs.luck, 0, 3),
        speed: clampInt(buffs.speed, 0, 2),
        defense: clampInt(buffs.defense, 0, 2),
        extraCasts: clampInt(buffs.extraCasts, 0, 9)
      }
    };
  }

  // Sorcery and scholar both add percent to spell damage.
  function spellFraction(h) {
    var pct = 10 * h.skills.sorcery + SCHOLAR[h.skills.scholar];
    return pct ? [100 + pct, 100] : ONE;
  }

  function moraleChance(h) { return CHANCE[h.skills.leadership] + CHANCE[h.buffs.morale]; }
  function luckChance(h) { return CHANCE[h.skills.luck] + CHANCE[h.buffs.luck]; }

  var ZERO_HERO = normalizeHero(null);

  // How much bigger the enemy host gets for a hero (0 = not at all), fitted
  // against the frozen casual-player proxy. The first attack point matters
  // most (it decides the opening dragon exchange); after that attack, defense,
  // extra Fireball casts, Fireball damage and the skill multipliers add up.
  var GROWTH = {
    firstAttack: 0.134, attack: 0.008, defense: 0.035, cast: 0.157, fireDamage: 0.125,
    offense: 0.912, armorer: 1.385, archery: 0.036, leadership: 0.825, luck: 0.825,
    logistics: 0.12, firstAid: 0.009, estates: 0.09, spread: 0.12
  };

  // Skills and stats only: the cheat army and buffs are meant to overpower.
  function heroStrength(h) {
    var sk = h.skills;
    var sorc = spellFraction(h);
    var extraCasts = Math.floor(h.knowledge / 5) + WISDOM[sk.wisdom];
    var fireGain = (FIREBALL_DAMAGE + 8 * h.power) * sorc[0] / sorc[1] / FIREBALL_DAMAGE - 1;
    var off = OFFENSE[sk.offense], arm = ARMORER[sk.armorer], arch = ARCHERY[sk.archery];
    var g = GROWTH.firstAttack * Math.min(h.attack, 1) + GROWTH.attack * h.attack + GROWTH.defense * h.defense +
      GROWTH.cast * extraCasts + GROWTH.fireDamage * fireGain + GROWTH.offense * (off[0] / off[1] - 1) +
      GROWTH.armorer * (1 - arm[0] / arm[1]) + GROWTH.archery * (arch[0] / arch[1] - 1) +
      (GROWTH.leadership * CHANCE[sk.leadership] + GROWTH.luck * CHANCE[sk.luck]) / 100 +
      GROWTH.logistics * LOGISTICS[sk.logistics] + GROWTH.firstAid * FIRST_AID[sk.firstAid] +
      GROWTH.estates * ESTATES[sk.estates];
    return g > 0 ? g : 0;
  }

  // The typical host multiplier for a hero: exactly 1 with no hero.
  function enemyScale(hero) {
    return 1 + heroStrength(normalizeHero(hero));
  }

  function heroOf(s) { return (s && s.hero) || ZERO_HERO; }

  function mulFrac(a, b) { return [a[0] * b[0], a[1] * b[1]]; }

  // The hero's bonus on one hit, as an exact fraction. Only ally stacks
  // benefit: archery or offense when they strike, armorer when they are hit.
  function damageBonus(s, attacker, target, kind) {
    var h = heroOf(s), f = ONE;
    if (attacker && attacker.side === 'ally') f = kind === 'ranged' ? ARCHERY[h.skills.archery] : OFFENSE[h.skills.offense];
    if (attacker && attacker.side === 'ally' && kind === 'retaliation') f = mulFrac(f, NAVIGATION[h.skills.navigation]);
    if (target && target.side === 'ally') f = mulFrac(f, ARMORER[h.skills.armorer]);
    return f;
  }

  // Fireball damage for the casting side: 50 + 8 x power, times sorcery,
  // times the target's armorer when an ally stack is caught in the blast.
  function fireballDamage(s, side, target) {
    var h = side === 'ally' ? heroOf(s) : ZERO_HERO;
    var f = spellFraction(h);
    if (target && target.side === 'ally') f = mulFrac(f, ARMORER[heroOf(s).skills.armorer]);
    return Math.max(1, Math.floor(((FIREBALL_DAMAGE + 8 * h.power) * f[0]) / f[1]));
  }

  /* ---------------------------------------------------------------- PRNG */

  // mulberry32, with its 32-bit state stored in s.rng so the state stays JSON.
  function nextRandom(s) {
    var a = (s.rng + 0x6D2B79F5) | 0;
    s.rng = a >>> 0;
    var t = Math.imul(a ^ (a >>> 15), a | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function randInt(s, lo, hi) {
    return lo + Math.floor(nextRandom(s) * (hi - lo + 1));
  }

  /* ------------------------------------------------------------ geometry */

  function hexKey(q, r) { return q + ',' + r; }
  function toOffset(q, r) { return { col: q + Math.floor(r / 2), row: r }; }
  function fromOffset(col, row) { return { q: col - Math.floor(row / 2), r: row }; }

  function onBoard(q, r) {
    if (r < 0 || r >= ROWS) return false;
    var c = q + Math.floor(r / 2);
    return c >= 0 && c < COLS;
  }

  function hexDistance(a, b) {
    var dq = a.q - b.q, dr = a.r - b.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }

  function neighbors(h) {
    var out = [];
    for (var i = 0; i < DIRS.length; i++) {
      var q = h.q + DIRS[i][0], r = h.r + DIRS[i][1];
      if (onBoard(q, r)) out.push({ q: q, r: r });
    }
    return out;
  }

  function allHexes() {
    var out = [];
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) out.push(fromOffset(c, r));
    }
    return out;
  }

  function boardIndex(h) { return h.r * COLS + h.q + Math.floor(h.r / 2); }
  function byBoardOrder(a, b) { return boardIndex(a) - boardIndex(b); }

  // The hex a breath attack also scorches: directly behind the target, seen
  // from the hex the attacker strikes from.
  function behindHex(from, target) {
    return { q: target.q + (target.q - from.q), r: target.r + (target.r - from.r) };
  }

  function fireballArea(h) {
    return [{ q: h.q, r: h.r }].concat(neighbors(h));
  }

  /* -------------------------------------------------------- state helpers */

  function clone(s) { return JSON.parse(JSON.stringify(s)); }

  function getStack(s, id) {
    for (var i = 0; i < s.stacks.length; i++) {
      if (s.stacks[i].id === id) return s.stacks[i];
    }
    return null;
  }

  function activeStack(s) { return s.active == null ? null : getStack(s, s.active); }
  function otherSide(side) { return side === 'ally' ? 'enemy' : 'ally'; }

  function aliveOf(s, side) {
    return s.stacks.filter(function (st) { return st.alive && st.side === side; });
  }

  function occupancy(s) {
    var m = {};
    s.stacks.forEach(function (st) { if (st.alive) m[hexKey(st.q, st.r)] = st; });
    return m;
  }

  function obstacleSet(s) {
    var m = {};
    s.obstacles.forEach(function (o) { m[hexKey(o.q, o.r)] = true; });
    return m;
  }

  function stackAt(s, q, r) {
    for (var i = 0; i < s.stacks.length; i++) {
      var st = s.stacks[i];
      if (st.alive && st.q === q && st.r === r) return st;
    }
    return null;
  }

  // A shooter is blocked while any enemy stands next to it.
  function isBlocked(s, st) {
    return aliveOf(s, otherSide(st.side)).some(function (f) { return hexDistance(st, f) === 1; });
  }

  // Hexes the stack can move to this turn (excluding its own hex), each with
  // the number of steps it takes. Flyers ignore everything in between; walkers
  // path around obstacles and other stacks.
  function reachable(s, st) {
    var occ = occupancy(s), obs = obstacleSet(s), out = [];
    if (st.fly) {
      allHexes().forEach(function (h) {
        var k = hexKey(h.q, h.r);
        if (obs[k] || occ[k]) return;
        var d = hexDistance(st, h);
        if (d >= 1 && d <= st.speed) out.push({ q: h.q, r: h.r, steps: d });
      });
      return out;
    }
    var seen = {};
    seen[hexKey(st.q, st.r)] = true;
    var frontier = [{ q: st.q, r: st.r }];
    for (var step = 1; step <= st.speed && frontier.length; step++) {
      var next = [];
      for (var i = 0; i < frontier.length; i++) {
        var ns = neighbors(frontier[i]);
        for (var j = 0; j < ns.length; j++) {
          var k = hexKey(ns[j].q, ns[j].r);
          if (seen[k] || obs[k] || occ[k]) continue;
          seen[k] = true;
          out.push({ q: ns[j].q, r: ns[j].r, steps: step });
          next.push(ns[j]);
        }
      }
      frontier = next;
    }
    out.sort(byBoardOrder);
    return out;
  }

  /* -------------------------------------------------------------- damage */

  // The attack/defence modifier as an exact fraction [numerator, denominator]:
  // 1 + min(0.05 d, 3) when d >= 0, else 1 - min(0.025 |d|, 0.7).
  // d is taken in fifths so a defending stack's exact +20% stays integral.
  function modifierFraction(att, def) {
    var d5 = Math.round(5 * (att - def));
    if (d5 >= 0) return [100 + Math.min(d5, 300), 100];
    return [200 - Math.min(-d5, 140), 200];
  }

  function damageModifier(att, def) {
    var f = modifierFraction(att, def);
    return f[0] / f[1];
  }

  // Defending adds exactly 20% defence until the stack's next turn.
  function effectiveDefence(st) {
    return st.defending ? (st.def * 6) / 5 : st.def;
  }

  // Exact integer maths: base = rollSum * count / min(count, 10), then the
  // modifier, the penalty (a product of halves, so exact in binary) and the
  // hero bonus fraction (exactly [1, 1] without a hero).
  function computeDamage(count, rollSum, att, def, penalty, bonus) {
    var k = Math.min(count, 10);
    var f = modifierFraction(att, def);
    var p = penalty == null ? 1 : penalty;
    var b = bonus || ONE;
    return Math.max(1, Math.floor((rollSum * count * f[0] * p * b[0]) / (k * f[1] * b[1])));
  }

  // Mean-roll damage used by the AI.
  function expectedDamage(attacker, target, penalty, count, bonus) {
    var n = count == null ? attacker.count : count;
    if (n <= 0) return 0;
    var f = modifierFraction(attacker.att, effectiveDefence(target));
    var p = penalty == null ? 1 : penalty;
    var b = bonus || ONE;
    return Math.max(1, n * (attacker.dmgMin + attacker.dmgMax) / 2 * f[0] / f[1] * p * b[0] / b[1]);
  }

  function meleePenalty(st) { return st.shoot ? 0.5 : 1; }

  function rangedPenalty(s, shooter, target) {
    var range = shooter.side === 'ally' ? EAGLE_EYE[heroOf(s).skills.eagleEye] : LONG_RANGE;
    return hexDistance(shooter, target) > range ? 0.5 : 1;
  }

  // Remove HP from the pooled total and recount the stack.
  function hurt(st, dmg) {
    var before = st.count;
    var dealt = Math.min(dmg, st.hpLeft);
    st.hpLeft -= dealt;
    st.count = Math.ceil(st.hpLeft / st.hp);
    var died = st.hpLeft <= 0;
    if (died) {
      st.hpLeft = 0;
      st.count = 0;
      st.alive = false;
      st.defending = false;
    }
    return { dealt: dealt, kills: before - st.count, died: died };
  }

  function strike(s, attacker, target, kind, penalty, events) {
    var k = Math.min(attacker.count, 10), sum = 0;
    for (var i = 0; i < k; i++) sum += randInt(s, attacker.dmgMin, attacker.dmgMax);
    var dmg = computeDamage(attacker.count, sum, attacker.att, effectiveDefence(target), penalty,
      damageBonus(s, attacker, target, kind));
    if (attacker.side === 'ally' && (kind === 'melee' || kind === 'ranged')) {
      var luck = luckChance(heroOf(s));
      if (luck > 0 && randInt(s, 1, 100) <= luck) {
        dmg *= 2;
        events.push({ type: 'luck', stack: attacker.id });
      }
    }
    var res = hurt(target, dmg);
    events.push({ type: 'damage', kind: kind, source: attacker.id, target: target.id,
      amount: dmg, dealt: res.dealt, kills: res.kills, died: res.died, left: target.count });
  }

  /* ---------------------------------------------------------- turn order */

  // Normal phase: fastest first, ally wins ties, then lineup order.
  // Wait phase: stacks that waited act slowest first (same tie rules).
  function pickNext(s) {
    var best = null, i, st;
    var tactics = s.round === 1 && heroOf(s).skills.tactics > 0;
    for (i = 0; i < s.stacks.length; i++) {
      st = s.stacks[i];
      if (!st.alive || st.acted || st.waited || st.passive) continue;
      if (best && tactics && st.side !== best.side) {
        if (st.side === 'ally') best = st;
        continue;
      }
      if (!best || st.speed > best.speed ||
          (st.speed === best.speed && st.side === 'ally' && best.side !== 'ally')) best = st;
    }
    if (best) return best;
    for (i = 0; i < s.stacks.length; i++) {
      st = s.stacks[i];
      if (!st.alive || st.acted || !st.waited || st.passive) continue;
      if (!best || st.speed < best.speed ||
          (st.speed === best.speed && st.side === 'ally' && best.side !== 'ally')) best = st;
    }
    return best;
  }

  // Ally stacks that still count as an army (machines do not).
  function armyLeft(s) {
    return aliveOf(s, 'ally').filter(function (st) { return !st.machine; }).length;
  }

  // First Aid skill, then each Tent, heal the most-wounded ally stack.
  function roundHeals(s, events) {
    var sources = [];
    var aid = FIRST_AID[heroOf(s).skills.firstAid];
    if (aid > 0) sources.push(['firstAid', aid]);
    s.stacks.forEach(function (st) { if (st.alive && st.passive && st.side === 'ally') sources.push([st.id, TENT_HEAL]); });
    sources.forEach(function (src) {
      var best = null;
      s.stacks.forEach(function (st) {
        if (!st.alive || st.side !== 'ally' || !(st.maxHp - st.hpLeft > 0)) return;
        if (!best || st.maxHp - st.hpLeft > best.maxHp - best.hpLeft) best = st;
      });
      if (!best) return;
      var gain = Math.min(src[1], best.maxHp - best.hpLeft);
      best.hpLeft += gain;
      best.count = Math.ceil(best.hpLeft / best.hp);
      events.push({ type: 'heal', source: src[0], target: best.id, amount: gain, left: best.count });
    });
  }

  function finish(s, result, reason, events) {
    s.result = result;
    s.endReason = reason;
    s.active = null;
    events.push({ type: 'end', result: result, reason: reason, round: s.round });
  }

  // Returns true when the battle is over.
  function checkEnd(s, events) {
    if (s.result) return true;
    var allies = armyLeft(s), enemies = aliveOf(s, 'enemy').length;
    // The ally wins once every enemy stack is down, even if a Fireball took
    // the last ally stack with it.
    if (enemies === 0) { finish(s, 'ally', 'wipe', events); return true; }
    if (allies === 0) { finish(s, 'enemy', 'wipe', events); return true; }
    return false;
  }

  function advance(s, events) {
    var next = pickNext(s);
    if (!next) {
      s.round += 1;
      s.stacks.forEach(function (st) {
        st.acted = false;
        st.waited = false;
        st.retaliated = false;
        st.moraled = false;
      });
      if (s.round >= ROUND_CAP) { finish(s, 'enemy', 'cap', events); return; }
      events.push({ type: 'round', round: s.round });
      roundHeals(s, events);
      next = pickNext(s);
    }
    s.active = next.id;
    next.defending = false;
    events.push({ type: 'turn', stack: next.id, round: s.round });
  }

  /* ------------------------------------------------------------ creation */

  function createBattle(opts) {
    opts = opts || {};
    var seed = Number(opts.seed == null ? 1 : opts.seed);
    if (!isFinite(seed)) seed = 0;
    seed = Math.floor(seed) >>> 0;
    var counts = opts.enemyCounts || {};
    var hero = normalizeHero(opts.hero);
    var s = {
      version: 1, seed: seed, rng: seed, cols: COLS, rows: ROWS,
      round: 1, actions: 0, active: null, result: null, endReason: null,
      hero: hero,
      spells: { ally: 1 + Math.floor(hero.knowledge / 5) + WISDOM[hero.skills.wisdom] + hero.buffs.extraCasts, enemy: 0 },
      obstacles: [], stacks: []
    };

    // 2-4 seeded obstacles in the three middle columns.
    var cand = [];
    for (var r = 0; r < ROWS; r++) {
      for (var c = 3; c <= 5; c++) cand.push(fromOffset(c, r));
    }
    var n = 2 + randInt(s, 0, 2);
    for (var i = 0; i < n; i++) {
      s.obstacles.push(cand.splice(randInt(s, 0, cand.length - 1), 1)[0]);
    }
    s.obstacles.sort(byBoardOrder);

    // The enemy grows to meet a stronger hero: exactly 1 for no hero.
    // Like neutral stacks in the wild, a grown host varies in size from
    // battle to battle (seeded). No hero: no growth and no extra draw, so the
    // battle is exactly the base one.
    var growth = opts.enemyGrowth != null ? Number(opts.enemyGrowth) : heroStrength(hero);
    var scale = 1;
    if (opts.enemyScale != null) scale = Number(opts.enemyScale);
    else if (growth > 0) scale = 1 + growth + GROWTH.spread * (2 * nextRandom(s) - 1);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    s.enemyScale = scale;

    var keep = DIPLOMACY[hero.skills.diplomacy];
    // Progressive difficulty from the page: 1 (or omitted) is the base battle.
    var difficulty = opts.difficulty == null ? 1 : Number(opts.difficulty);
    if (!isFinite(difficulty) || difficulty <= 0) difficulty = 1;
    difficulty = Math.max(0.25, Math.min(3, difficulty));
    s.difficulty = difficulty;
    // Damped: below 1 each step of difficulty moves enemy counts by 30% of
    // it, above 1 by 20% (the battle is steeper in that direction).
    var countFactor = 1 + (difficulty < 1 ? 0.3 : 0.2) * (difficulty - 1);
    var fwd = PATHFINDING[hero.skills.pathfinding];
    s.deserted = 0;

    function addStack(type, count, hex) {
      var u = UNITS[type], ally = u.side === 'ally';
      var speed = u.speed > 0 && ally ? u.speed + LOGISTICS[hero.skills.logistics] + hero.buffs.speed : u.speed;
      s.stacks.push({
        id: type, type: type, side: u.side, name: u.name, one: u.one,
        att: u.att + (ally ? hero.attack : 0),
        def: u.def + (ally ? hero.defense + hero.buffs.defense : 0),
        dmgMin: u.dmgMin, dmgMax: u.dmgMax, hp: u.hp, speed: speed,
        fly: !!u.fly, breath: !!u.breath, shoot: !!u.shoot, noRetaliation: !!u.noRetaliation,
        machine: !!u.machine, passive: !!u.passive,
        count: count, hpLeft: count * u.hp, maxHp: count * u.hp, q: hex.q, r: hex.r,
        alive: true, acted: false, waited: false, defending: false, retaliated: false, moraled: false
      });
    }

    LINEUP.forEach(function (slot) {
      var u = UNITS[slot.type];
      var count = u.count;
      if (u.side === 'enemy' && scale !== 1 && u.count > 1) count = Math.max(1, Math.round(u.count * scale));
      if (u.side === 'enemy' && counts[slot.type] != null) count = Math.max(1, Math.floor(counts[slot.type]));
      if (u.side === 'enemy' && keep !== ONE && count > 1) {
        var kept = Math.max(1, Math.round(count * keep[0] / keep[1]));
        s.deserted += count - kept;
        count = kept;
      }
      if (u.side === 'enemy' && difficulty !== 1 && count > 1) {
        // Seeded stochastic rounding, so small steps still change the host
        // on average instead of rounding away.
        var exact = count * countFactor;
        count = Math.max(1, Math.floor(exact) + (nextRandom(s) < exact - Math.floor(exact) ? 1 : 0));
      }
      // A shrunken host never leaves a stack weaker than the Teal Dragon:
      // otherwise weakest-first players switch targets and, perversely, a
      // smaller host becomes harder to beat (it binds the Wraiths at 10).
      if (u.side === 'enemy' && u.count > 1 && counts[slot.type] == null) {
        count = Math.max(count, Math.ceil(UNITS.tealDragon.hp / u.hp));
      }
      if (slot.type === 'genieArchers') count += ESTATES[hero.skills.estates];
      addStack(slot.type, count, fromOffset(u.side === 'ally' ? fwd : COLS - 1, slot.row));
    });

    // The cheat army takes the first free hex from its list of spots.
    var extras = [];
    if (hero.army.archangels > 0) extras.push(['archangels', hero.army.archangels, [[fwd, 1], [fwd + 1, 1], [fwd + 1, 2], [fwd + 1, 0]]]);
    if (hero.army.blackKnights > 0) extras.push(['blackKnights', hero.army.blackKnights, [[fwd, 5], [fwd + 1, 5], [fwd + 1, 4], [fwd + 1, 6]]]);
    if (hero.army.ballista) extras.push(['ballista', 1, [[0, 3], [0, 1], [0, 5], [1, 3], [1, 2], [1, 4]]]);
    if (hero.army.firstAidTent) extras.push(['firstAidTent', 1, [[0, 3], [0, 1], [0, 5], [1, 3], [1, 4], [1, 2]]]);
    var obs = obstacleSet(s);
    extras.forEach(function (x) {
      var spots = x[2].concat([[0, 0], [1, 0], [1, 6], [2, 1], [2, 3], [2, 5], [0, 6], [2, 0], [2, 2], [2, 4], [2, 6]]);
      for (var i = 0; i < spots.length; i++) {
        var h = fromOffset(spots[i][0], spots[i][1]);
        if (onBoard(h.q, h.r) && !obs[hexKey(h.q, h.r)] && !stackAt(s, h.q, h.r)) { addStack(x[0], x[1], h); return; }
      }
    });

    advance(s, []);
    return s;
  }

  /* ------------------------------------------------------------- actions */

  function legalActions(s) {
    if (!s || s.result) return [];
    var me = activeStack(s);
    if (!me || !me.alive) return [];
    var acts = [];
    if (s.spells[me.side] > 0) {
      allHexes().forEach(function (h) { acts.push({ type: 'fireball', target: { q: h.q, r: h.r } }); });
    }
    var foes = aliveOf(s, otherSide(me.side));
    var blocked = isBlocked(s, me);
    if (me.shoot && (!blocked || me.machine)) {
      foes.forEach(function (f) { acts.push({ type: 'shoot', target: f.id }); });
    }
    var reach = reachable(s, me);
    if (!me.machine && (!me.shoot || blocked)) {
      var spots = [{ q: me.q, r: me.r }].concat(reach);
      foes.forEach(function (f) {
        spots.forEach(function (h) {
          if (hexDistance(h, f) === 1) acts.push({ type: 'attack', target: f.id, from: { q: h.q, r: h.r } });
        });
      });
    }
    reach.forEach(function (h) { acts.push({ type: 'move', to: { q: h.q, r: h.r } }); });
    if (!me.waited) acts.push({ type: 'wait' });
    acts.push({ type: 'defend' });
    if (me.side === 'ally') acts.push({ type: 'retreat' });
    return acts;
  }

  function actionKey(a) {
    switch (a.type) {
      case 'fireball': return 'fireball:' + hexKey(a.target.q, a.target.r);
      case 'move': return 'move:' + hexKey(a.to.q, a.to.r);
      case 'attack': return 'attack:' + a.target + '@' + hexKey(a.from.q, a.from.r);
      case 'shoot': return 'shoot:' + a.target;
      default: return String(a.type);
    }
  }

  function isLegal(s, action) {
    var key;
    try { key = actionKey(action); } catch (e) { return false; }
    return legalActions(s).some(function (a) { return actionKey(a) === key; });
  }

  function applyAction(state, action) {
    if (!action || typeof action.type !== 'string') throw new Error('Battleground: an action needs a type');
    if (!state || state.result) throw new Error('Battleground: the battle is already over');
    if (!isLegal(state, action)) throw new Error('Battleground: illegal action ' + JSON.stringify(action));

    var s = clone(state);
    var events = [];
    var me = activeStack(s);
    s.actions += 1;

    switch (action.type) {
      case 'fireball': {
        s.spells[me.side] -= 1;
        var area = fireballArea(action.target);
        events.push({ type: 'fireball', side: me.side, target: { q: action.target.q, r: action.target.r }, area: area });
        area.forEach(function (h) {
          var st = stackAt(s, h.q, h.r);
          if (!st) return;
          var dmg = fireballDamage(s, me.side, st);
          var res = hurt(st, dmg);
          events.push({ type: 'damage', kind: 'fireball', source: null, target: st.id,
            amount: dmg, dealt: res.dealt, kills: res.kills, died: res.died, left: st.count });
        });
        // A free action: the same stack keeps its turn unless the blast felled it.
        if (!checkEnd(s, events) && !me.alive) advance(s, events);
        return { state: s, events: events };
      }
      case 'move': {
        events.push({ type: 'move', stack: me.id, from: { q: me.q, r: me.r }, to: { q: action.to.q, r: action.to.r } });
        me.q = action.to.q;
        me.r = action.to.r;
        me.acted = true;
        break;
      }
      case 'attack': {
        var target = getStack(s, action.target);
        if (action.from.q !== me.q || action.from.r !== me.r) {
          events.push({ type: 'move', stack: me.id, from: { q: me.q, r: me.r }, to: { q: action.from.q, r: action.from.r } });
          me.q = action.from.q;
          me.r = action.from.r;
        }
        events.push({ type: 'attack', stack: me.id, target: target.id });
        strike(s, me, target, 'melee', meleePenalty(me), events);
        if (me.breath) {
          var b = behindHex(me, target);
          var second = stackAt(s, b.q, b.r);
          if (second && second.side !== me.side) strike(s, me, second, 'breath', meleePenalty(me), events);
        }
        if (target.alive && !target.retaliated && !me.noRetaliation && !target.machine) {
          target.retaliated = true;
          strike(s, target, me, 'retaliation', meleePenalty(target), events);
        }
        me.acted = true;
        break;
      }
      case 'shoot': {
        var t = getStack(s, action.target);
        var d = hexDistance(me, t);
        events.push({ type: 'shot', stack: me.id, target: t.id, distance: d, long: d > LONG_RANGE });
        strike(s, me, t, 'ranged', rangedPenalty(s, me, t), events);
        me.acted = true;
        break;
      }
      case 'wait': {
        me.waited = true;
        events.push({ type: 'wait', stack: me.id });
        break;
      }
      case 'defend': {
        me.defending = true;
        me.acted = true;
        events.push({ type: 'defend', stack: me.id });
        break;
      }
      case 'retreat': {
        events.push({ type: 'retreat', stack: me.id });
        finish(s, 'enemy', 'retreat', events);
        return { state: s, events: events };
      }
      default:
        throw new Error('Battleground: unknown action ' + action.type);
    }

    if (!checkEnd(s, events) && !moraleBoost(s, me, action, events)) advance(s, events);
    return { state: s, events: events };
  }

  // Leadership (and the morale buff): after an ally stack moves, attacks or
  // shoots, a chance that it acts again this round, once per round.
  function moraleBoost(s, me, action, events) {
    if (me.side !== 'ally' || !me.alive || me.moraled) return false;
    if (action.type !== 'move' && action.type !== 'attack' && action.type !== 'shoot') return false;
    var chance = moraleChance(heroOf(s));
    if (chance <= 0 || randInt(s, 1, 100) > chance) return false;
    me.moraled = true;
    events.push({ type: 'morale', stack: me.id });
    events.push({ type: 'turn', stack: me.id, round: s.round });
    return true;
  }

  function outcome(s) {
    if (!s) return null;
    if (s.result) return s.result;
    if (aliveOf(s, 'enemy').length === 0) return 'ally';
    if (armyLeft(s) === 0) return 'enemy';
    return null;
  }

  // Damage range preview for the UI (primary target only).
  function estimateAction(s, action) {
    var me = activeStack(s);
    if (!me || !action) return null;
    var t = getStack(s, action.target);
    if (!t || !t.alive) return null;
    var penalty;
    if (action.type === 'shoot') penalty = rangedPenalty(s, me, t);
    else if (action.type === 'attack') penalty = meleePenalty(me);
    else return null;
    var k = Math.min(me.count, 10), def = effectiveDefence(t);
    var bonus = damageBonus(s, me, t, action.type === 'shoot' ? 'ranged' : 'melee');
    var lo = computeDamage(me.count, k * me.dmgMin, me.att, def, penalty, bonus);
    var hi = computeDamage(me.count, k * me.dmgMax, me.att, def, penalty, bonus);
    function kills(dmg) { return t.count - Math.ceil(Math.max(0, t.hpLeft - dmg) / t.hp); }
    return { min: lo, max: hi, killsMin: kills(lo), killsMax: kills(hi), penalty: penalty };
  }

  /* ------------------------------------------------------------------ AI */

  var EPS = 1e-9;

  // The best Fireball hex for a side: most enemy HP removed, no own stack hit.
  function bestFireball(s, side) {
    var occ = occupancy(s), best = null;
    allHexes().forEach(function (h) {
      var value = 0, kills = 0, friendly = false;
      fireballArea(h).forEach(function (a) {
        var st = occ[hexKey(a.q, a.r)];
        if (!st) return;
        if (st.side === side) { friendly = true; return; }
        var dmg = fireballDamage(s, side, st);
        value += Math.min(dmg, st.hpLeft);
        if (st.hpLeft <= dmg) kills += 1;
      });
      if (friendly || value <= 0) return;
      if (!best || value > best.value) best = { target: { q: h.q, r: h.r }, value: value, kills: kills };
    });
    return best;
  }

  function aiFireball(s, side) {
    var fb = bestFireball(s, side);
    if (!fb) return null;
    if (fb.value >= 2 * fireballDamage(s, side) || fb.kills > 0 || s.round >= 3) {
      return { type: 'fireball', target: fb.target };
    }
    return null;
  }

  function adjacentFoes(s, h, me) {
    var n = 0;
    aliveOf(s, otherSide(me.side)).forEach(function (f) { if (hexDistance(h, f) === 1) n += 1; });
    return n;
  }

  // Score every reachable melee target: expDmg/targetHP + 0.6 kill + 0.4 shooter
  // + 0.3 breath bonus - 0.5 expRetaliation/ownHP. Each target is attacked from
  // the reachable adjacent hex with the best breath, then fewest adjacent foes.
  function meleeOptions(s, me) {
    if (me.machine) return [];
    var spots = [{ q: me.q, r: me.r, steps: 0 }].concat(reachable(s, me));
    var foes = aliveOf(s, otherSide(me.side));
    var out = [];
    foes.forEach(function (f) {
      var best = null;
      spots.forEach(function (h) {
        if (hexDistance(h, f) !== 1) return;
        var breath = 0;
        if (me.breath) {
          var b = behindHex(h, f);
          var second = stackAt(s, b.q, b.r);
          if (second && second.side !== me.side) breath = 1;
        }
        var adj = adjacentFoes(s, h, me);
        if (!best || breath > best.breath ||
            (breath === best.breath && (adj < best.adj || (adj === best.adj && h.steps < best.steps)))) {
          best = { q: h.q, r: h.r, steps: h.steps, breath: breath, adj: adj };
        }
      });
      if (!best) return;
      var exp = Math.min(expectedDamage(me, f, meleePenalty(me), null, damageBonus(s, me, f, 'melee')), f.hpLeft);
      var kills = exp >= f.hpLeft;
      var ret = 0;
      if (!kills && !f.retaliated && !me.noRetaliation && !f.machine) {
        var cnt = Math.ceil((f.hpLeft - exp) / f.hp);
        ret = Math.min(expectedDamage(f, me, meleePenalty(f), cnt, damageBonus(s, f, me, 'retaliation')), me.hpLeft);
      }
      var score = exp / f.hpLeft + (kills ? 0.6 : 0) + (f.shoot ? 0.4 : 0) +
        (best.breath ? 0.3 : 0) - 0.5 * ret / me.hpLeft;
      out.push({ score: score, action: { type: 'attack', target: f.id, from: { q: best.q, r: best.r } } });
    });
    return out;
  }

  // Walking distance to the target (1 = adjacent); flyers use hex distance.
  function distanceTo(s, me, target) {
    if (me.fly) return function (h) { return hexDistance(h, target); };
    var occ = occupancy(s), obs = obstacleSet(s), dist = {};
    dist[hexKey(target.q, target.r)] = 0;
    var frontier = [{ q: target.q, r: target.r }];
    for (var d = 1; frontier.length; d++) {
      var next = [];
      for (var i = 0; i < frontier.length; i++) {
        var ns = neighbors(frontier[i]);
        for (var j = 0; j < ns.length; j++) {
          var k = hexKey(ns[j].q, ns[j].r);
          if (dist[k] != null || obs[k]) continue;
          var o = occ[k];
          if (o && o !== me) continue;
          dist[k] = d;
          next.push(ns[j]);
        }
      }
      frontier = next;
    }
    return function (h) {
      var v = dist[hexKey(h.q, h.r)];
      return v == null ? 1000 + hexDistance(h, target) : v;
    };
  }

  function aiAction(s) {
    if (!s || s.result) return null;
    var me = activeStack(s);
    if (!me) return null;
    var foes = aliveOf(s, otherSide(me.side));

    if (s.spells[me.side] > 0) {
      var fb = aiFireball(s, me.side);
      if (fb) return fb;
    }

    if (me.shoot && (!isBlocked(s, me) || me.machine)) {
      var bestT = null, bestS = -Infinity;
      foes.forEach(function (f) {
        var exp = Math.min(expectedDamage(me, f, rangedPenalty(s, me, f), null, damageBonus(s, me, f, 'ranged')), f.hpLeft);
        var sc = exp / f.hpLeft + (exp >= f.hpLeft ? 0.6 : 0) + (f.shoot ? 0.4 : 0);
        if (sc > bestS + EPS) { bestS = sc; bestT = f; }
      });
      if (bestT) return { type: 'shoot', target: bestT.id };
    }

    var opts = meleeOptions(s, me);
    if (opts.length) {
      var pick = opts[0];
      for (var i = 1; i < opts.length; i++) if (opts[i].score > pick.score + EPS) pick = opts[i];
      return pick.action;
    }

    // Advance toward the top threat: the foe that would hurt this stack most.
    var threat = null, tScore = -Infinity;
    foes.forEach(function (f) {
      var threatDmg = expectedDamage(f, me, 1, null, damageBonus(s, f, me, f.shoot ? 'ranged' : 'melee'));
      var sc = Math.min(threatDmg, me.hpLeft) / me.hpLeft + (f.shoot ? 0.4 : 0);
      if (sc > tScore + EPS) { tScore = sc; threat = f; }
    });
    if (threat) {
      var distFn = distanceTo(s, me, threat);
      var cur = distFn(me), best = null, bestD = Infinity;
      reachable(s, me).forEach(function (h) {
        var d = distFn(h);
        if (d < bestD) { bestD = d; best = h; }
      });
      if (best && bestD < cur) return { type: 'move', to: { q: best.q, r: best.r } };
    }
    return { type: 'defend' };
  }

  return {
    COLS: COLS,
    ROWS: ROWS,
    ROUND_CAP: ROUND_CAP,
    FIREBALL_DAMAGE: FIREBALL_DAMAGE,
    normalizeHero: normalizeHero,
    enemyScale: enemyScale,
    heroStrength: heroStrength,
    damageBonus: damageBonus,
    fireballDamage: fireballDamage,
    LONG_RANGE: LONG_RANGE,
    UNITS: UNITS,
    createBattle: createBattle,
    legalActions: legalActions,
    applyAction: applyAction,
    aiAction: aiAction,
    outcome: outcome,
    isLegal: isLegal,
    estimateAction: estimateAction,
    activeStack: activeStack,
    getStack: getStack,
    stackAt: stackAt,
    reachable: reachable,
    isBlocked: isBlocked,
    hexDistance: hexDistance,
    neighbors: neighbors,
    onBoard: onBoard,
    toOffset: toOffset,
    fromOffset: fromOffset,
    allHexes: allHexes,
    behindHex: behindHex,
    fireballArea: fireballArea,
    damageModifier: damageModifier,
    computeDamage: computeDamage,
    expectedDamage: expectedDamage,
    effectiveDefence: effectiveDefence
  };
}));
