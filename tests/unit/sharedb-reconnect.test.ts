import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { Config } from "../../src/config.ts";
import { ShareDBClient } from "../../src/transport/sharedb.ts";

type Behavior = "full" | "handshake-only" | "drop-on-connect";

const SNAPSHOT = { key: "t", title: "t", itinerary: { sections: [] } };

function startServer(behavior: () => Behavior) {
  const wss = new WebSocketServer({ port: 0 });
  const sockets = new Set<import("ws").WebSocket>();
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    const mode = behavior();
    if (mode === "drop-on-connect") {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify({ a: "init", id: "sess", protocol: 1, protocolMinor: 2, type: "x" }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.a === "hs") ws.send(JSON.stringify({ a: "hs", id: "sess" }));
      // "handshake-only": never ack the subscribe, so it is still pending when we drop the socket.
      if (msg.a === "s" && mode === "full") {
        ws.send(JSON.stringify({ a: "s", data: { v: 1, data: SNAPSHOT } }));
      }
    });
  });
  const port = (wss.address() as AddressInfo).port;
  const config: Config = {
    cookieHeader: "connect.sid=x",
    baseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    userAgent: "test",
  };
  return {
    wss,
    sockets,
    config,
    stop: () => {
      for (const s of sockets) s.terminate();
      wss.close();
    },
  };
}

describe("ShareDBClient reconnect resilience", () => {
  const cleanups: Array<() => void> = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    process.off("uncaughtException", onUnhandled);
    while (cleanups.length) cleanups.pop()!();
    unhandled.length = 0;
    vi.useRealTimers();
  });

  function track() {
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUnhandled);
  }

  it("does not raise an unhandled rejection when the socket drops during the resubscribe after a reconnect", async () => {
    track();
    let mode: Behavior = "full";
    const srv = startServer(() => mode);
    cleanups.push(srv.stop);
    const client = new ShareDBClient(srv.config, "t");
    cleanups.push(() => client.close());

    await client.subscribe();
    expect(client.isSubscribed).toBe(true);

    // Next connection completes the handshake but never acks the subscribe.
    mode = "handshake-only";
    const reconnected = new Promise<void>((r) => client.once("closed", () => r()));
    for (const s of srv.sockets) s.terminate();
    await reconnected;

    // Wait for the reconnect to connect and send its (unacked) subscribe, then drop it again.
    await vi.waitFor(() => expect(srv.sockets.size).toBe(1), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 100));
    for (const s of srv.sockets) s.terminate();

    await new Promise((r) => setTimeout(r, 300));
    expect(unhandled).toEqual([]);
  }, 15_000);

  it("rejects connect() when the socket closes before the handshake completes", async () => {
    track();
    const srv = startServer(() => "drop-on-connect");
    cleanups.push(srv.stop);
    const client = new ShareDBClient(srv.config, "t");
    cleanups.push(() => client.close());

    const outcome = await Promise.race([
      client.connect().then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((r) => setTimeout(() => r("hung"), 3000)),
    ]);
    expect(outcome).toBe("rejected");
    expect(unhandled).toEqual([]);
  }, 10_000);

  it("recovers on the next call after an idle drop", async () => {
    track();
    const srv = startServer(() => "full");
    cleanups.push(srv.stop);
    const client = new ShareDBClient(srv.config, "t");
    cleanups.push(() => client.close());

    await client.subscribe();
    const reconnected = new Promise<void>((r) => client.once("reconnected", () => r()));
    for (const s of srv.sockets) s.terminate();
    await reconnected;

    expect(client.isSubscribed).toBe(true);
    expect(unhandled).toEqual([]);
  }, 15_000);
});
