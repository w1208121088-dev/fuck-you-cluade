import { DurableObject } from "cloudflare:workers";

const VERSION = "v1.1-cloudflare";
const STARTING_CASH = 100000;
const DRIFT_INTERVAL_MS = 10_000;
const MARKET_EVENT_INTERVAL_MS = 2 * 60 * 60 * 1000;

const STONES_BASE = {
  "蓝水（水合二氧化铱）": 70000,
  "金": 21000,
  "银": 3500,
  "镍": 9000,
  "钨": 8500,
  "钴": 7800,
  "钛": 6200,
  "铬": 2700,
  "铜": 2200,
  "铝": 1800,
  "锌": 2500,
  "锡": 3000,
  "钼": 2600,
  "稀土磁材": 6500,
  "碳纤维": 4700,
  "凯夫拉": 4300,
  "铍铜": 5200,
  "因瓦合金": 5600,
  "哈氏合金": 7800,
  "因科镍合金": 7200,
  "超高强钢": 5100,
  "有色水晶": 1700,
};

const RABBITS_BASE = {
  "雪怪兔": { price: 950, desc: "过于夸张的大兔脚。" },
  "圣花兔": { price: 777, desc: "缝纫机头缠绕着荆棘的兔子。" },
  "三角洲兔": { price: 771, desc: "背上有A字红色标记的网格毛色兔子。" },
  "海豹兔": { price: 816, desc: "有大胡子和纹身的兔子。" },
  '"水"兔': { price: 848, desc: "全身都像泡在低饱和像素中的兔子。" },
  "素子兔": { price: 899, desc: "全身机械的兔子，能像祈臣一样隐身。" },
  "火锅兔": { price: 500, desc: "毛色像火锅一般。" },
  "烩面兔": { price: 377, desc: "毛色长短不均，像白汤中的面条。" },
  "生煎兔": { price: 634, desc: "太过哈韩，有高丽旗纹身的兔子。" },
  "主任兔": { price: 400, desc: "脾气暴躁的兔子，爱国之心毋庸置疑。" },
  "花旗兔": { price: 177, desc: "不要对它说俄语。" },
  "太子兔": { price: 266, desc: "全身被阴影覆盖，只能看到剪影的神秘兔子。" },
  "千禧年": { price: 200, desc: "头部有个电子屏，显示hello world。" },
  "法官兔": { price: 333, desc: "赵志先生。" },
  "清华兔": { price: 348, desc: "穿着中山装的兔子。" },
};

function allItems() {
  return [
    ...Object.keys(STONES_BASE).map((item) => ({ category: "stones", item, base: STONES_BASE[item] })),
    ...Object.keys(RABBITS_BASE).map((item) => ({ category: "rabbits", item, base: RABBITS_BASE[item].price })),
  ];
}

function randomDriftNumber() {
  return Math.random() * 0.04 - 0.02;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/ws/")) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const playerId = decodeURIComponent(url.pathname.slice("/ws/".length));
      if (!playerId || playerId.length > 128) {
        return new Response("Invalid player id", { status: 400 });
      }

      const id = env.MARKET.idFromName("global-market");
      const stub = env.MARKET.get(id);
      // Forward the original WebSocket upgrade request unchanged.
      // Rebuilding the Request can drop or alter WebSocket upgrade metadata
      // in some runtimes, which causes the Durable Object to return 426.
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

export class MarketDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.sql = ctx.storage.sql;

    this.ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS players (
          player_id TEXT PRIMARY KEY,
          cash REAL NOT NULL,
          stones TEXT NOT NULL,
          rabbits TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS market_items (
          category TEXT NOT NULL,
          item TEXT NOT NULL,
          price REAL NOT NULL,
          PRIMARY KEY (category, item)
        );

        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      const count = this.sql.exec(`SELECT COUNT(*) AS count FROM market_items`).one().count;
      if (Number(count) === 0) {
        for (const { category, item, base } of allItems()) {
          this.sql.exec(
            `INSERT INTO market_items (category, item, price) VALUES (?, ?, ?)`,
            category,
            item,
            base,
          );
        }
      }

      const lastEvent = this.sql.exec(`SELECT value FROM meta WHERE key = 'last_event'`).toArray();
      if (lastEvent.length === 0) {
        this.sql.exec(
          `INSERT INTO meta (key, value) VALUES ('last_event', ?)`,
          String(Date.now()),
        );
      }

      if ((await this.ctx.storage.getAlarm()) == null) {
        this.ctx.storage.setAlarm(Date.now() + DRIFT_INTERVAL_MS);
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/ws/")) {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const playerId = decodeURIComponent(url.pathname.slice("/ws/".length));
    if (!playerId) {
      return new Response("Missing playerId", { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId });

    await this.ensurePlayer(playerId);
    server.send(JSON.stringify(this.marketSnapshot()));
    server.send(JSON.stringify({ type: "player", data: this.loadPlayer(playerId) }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    try {
      this.applyRandomDrift();

      const lastEvent = Number(this.getMeta("last_event") ?? Date.now());
      const now = Date.now();
      if (now - lastEvent >= MARKET_EVENT_INTERVAL_MS) {
        this.applyMarketEvent();
        this.setMeta("last_event", String(now));
      }

      this.broadcast(JSON.stringify(this.marketSnapshot()));
    } catch (error) {
      console.error("market alarm failed", error);
    } finally {
      this.ctx.storage.setAlarm(Date.now() + DRIFT_INTERVAL_MS);
    }
  }

  async webSocketMessage(ws, message) {
    const connection = ws.deserializeAttachment();
    const playerId = connection?.playerId;
    if (!playerId) {
      ws.send(JSON.stringify({ type: "error", msg: "连接状态无效，请刷新页面" }));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      ws.send(JSON.stringify({ type: "error", msg: "无效的消息格式" }));
      return;
    }

    if (msg?.action === "buy") {
      await this.handleTrade(ws, playerId, msg, true);
    } else if (msg?.action === "sell") {
      await this.handleTrade(ws, playerId, msg, false);
    }
  }

  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // Socket may already be closed.
    }
  }

  webSocketError(ws, error) {
    console.error("WebSocket error", error);
    try {
      ws.close(1011, "WebSocket error");
    } catch {
      // Socket may already be closed.
    }
  }

  getMeta(key) {
    return this.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).one()?.value ?? null;
  }

  setMeta(key, value) {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  marketSnapshot() {
    const rows = this.sql
      .exec(`SELECT category, item, price FROM market_items ORDER BY rowid`)
      .toArray();

    const stones = {};
    const rabbits = {};
    for (const row of rows) {
      if (row.category === "stones") stones[row.item] = Number(row.price);
      if (row.category === "rabbits") rabbits[row.item] = Number(row.price);
    }
    return { type: "market", stones, rabbits };
  }

  getPrice(category, item) {
    return this.sql
      .exec(`SELECT price FROM market_items WHERE category = ? AND item = ?`, category, item)
      .one()?.price;
  }

  setPrice(category, item, price) {
    this.sql.exec(
      `UPDATE market_items SET price = ? WHERE category = ? AND item = ?`,
      price,
      category,
      item,
    );
  }

  getBasePrice(category, item) {
    if (category === "stones") return STONES_BASE[item];
    if (category === "rabbits") return RABBITS_BASE[item]?.price;
    return undefined;
  }

  loadPlayer(playerId) {
    const row = this.sql
      .exec(`SELECT cash, stones, rabbits FROM players WHERE player_id = ?`, playerId)
      .one();
    if (!row) return null;
    return {
      cash: Number(row.cash),
      stones: JSON.parse(row.stones),
      rabbits: JSON.parse(row.rabbits),
    };
  }

  savePlayer(playerId, player) {
    this.sql.exec(
      `INSERT INTO players (player_id, cash, stones, rabbits)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         cash=excluded.cash,
         stones=excluded.stones,
         rabbits=excluded.rabbits`,
      playerId,
      player.cash,
      JSON.stringify(player.stones),
      JSON.stringify(player.rabbits),
    );
  }

  ensurePlayer(playerId) {
    const existing = this.loadPlayer(playerId);
    if (existing) {
      let changed = false;
      for (const item of Object.keys(STONES_BASE)) {
        if (!(item in existing.stones)) {
          existing.stones[item] = 0;
          changed = true;
        }
      }
      for (const item of Object.keys(RABBITS_BASE)) {
        if (!(item in existing.rabbits)) {
          existing.rabbits[item] = 0;
          changed = true;
        }
      }
      if (changed) this.savePlayer(playerId, existing);
      return existing;
    }

    const player = {
      cash: STARTING_CASH,
      stones: Object.fromEntries(Object.keys(STONES_BASE).map((item) => [item, 0])),
      rabbits: Object.fromEntries(Object.keys(RABBITS_BASE).map((item) => [item, 0])),
    };
    this.savePlayer(playerId, player);
    return player;
  }

  applyRandomDrift() {
    for (const { category, item, base } of allItems()) {
      const price = Number(this.getPrice(category, item));
      const drift = randomDriftNumber();
      const next = price * (1 + drift);
      this.setPrice(category, item, this.clampPrice(next, base));
    }
  }

  applyMarketEvent() {
    const items = allItems();
    const chosen = items.sort(() => Math.random() - 0.5).slice(0, Math.min(5, items.length));
    for (const { category, item, base } of chosen) {
      const direction = Math.random() < 0.5 ? 1 : -1;
      const magnitude = randomBetween(0.10, 0.40);
      const price = Number(this.getPrice(category, item));
      const next = price * (1 + direction * magnitude);
      this.setPrice(category, item, this.clampPrice(next, base));
    }
  }

  clampPrice(price, base) {
    return Math.round(Math.max(base * 0.2, Math.min(base * 5.0, price)) * 100) / 100;
  }

  applyPriceImpact(category, item, qty, isBuy) {
    const base = this.getBasePrice(category, item) ?? 1;
    const impact = Math.min((qty / base) * 0.8, 0.15);
    const factor = 1 + (isBuy ? impact : -impact);
    const current = Number(this.getPrice(category, item));
    this.setPrice(category, item, this.clampPrice(current * factor, base));
  }

  async handleTrade(ws, playerId, msg, isBuy) {
    const category = msg?.category;
    const item = msg?.item;
    let qty = Number(msg?.qty ?? 0);

    if (!Number.isFinite(qty) || qty <= 0) {
      ws.send(JSON.stringify({ type: "error", msg: "数量必须大于0" }));
      return;
    }

    if (category !== "stones" && category !== "rabbits") {
      ws.send(JSON.stringify({ type: "error", msg: "未知品类" }));
      return;
    }

    if (category === "rabbits") qty = Math.trunc(qty);

    const price = this.getPrice(category, item);
    const base = this.getBasePrice(category, item);
    if (price == null || base == null) {
      ws.send(JSON.stringify({ type: "error", msg: "未知商品" }));
      return;
    }

    const player = this.ensurePlayer(playerId);
    const holdingKey = category;
    const total = Number(price) * qty;

    if (isBuy) {
      if (player.cash < total) {
        ws.send(JSON.stringify({
          type: "error",
          msg: `钞不够，需要 ${total.toFixed(0)} 钞，你只有 ${player.cash.toFixed(0)} 钞`,
        }));
        return;
      }
      player.cash -= total;
      player[holdingKey][item] = (player[holdingKey][item] ?? 0) + qty;
    } else {
      const holding = Number(player[holdingKey][item] ?? 0);
      if (holding < qty) {
        ws.send(JSON.stringify({ type: "error", msg: `持仓不足，你只有 ${holding}` }));
        return;
      }
      player.cash += total;
      player[holdingKey][item] = holding - qty;
    }

    this.applyPriceImpact(category, item, qty, isBuy);
    this.savePlayer(playerId, player);

    const actionWord = isBuy ? "买入" : "卖出";
    ws.send(JSON.stringify({
      type: "trade_ok",
      msg: `${actionWord} ${item} ×${qty}，成交价 ${Number(price).toFixed(0)} 钞/单位，合计 ${total.toFixed(0)} 钞`,
      data: player,
    }));

    this.broadcast(JSON.stringify(this.marketSnapshot()));
  }

  broadcast(message) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch (error) {
          console.error("broadcast failed", error);
        }
      }
    }
  }
}
