import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "../testing";
import { OpenCodeClient, OpenCodeHttpError, loopbackUrl, type OpenCodeEvent } from "./opencode-api";

const servers: http.Server[] = [];

async function listen(handler: http.RequestListener): Promise<URL> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const frame = (type: string, data: unknown = {}): string => `data: ${JSON.stringify({ id: "evt_1", type, data })}\n\n`;
const basic = (password: string): string => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

describe("loopbackUrl", () => {
  it("only accepts plain-http loopback addresses, because the server password goes wherever the URL points", () => {
    for (const good of ["http://127.0.0.1:4096", "http://localhost:80", "http://[::1]:5"]) expect(loopbackUrl(good)).toBeInstanceOf(URL);
    for (const bad of ["https://127.0.0.1:4096", "http://example.com:80", "http://127.0.0.1.evil.com:80", "ftp://127.0.0.1", "not a url", ""]) {
      expect(loopbackUrl(bad), bad).toBeUndefined();
    }
  });
});

describe("OpenCodeClient.request", () => {
  it("sends Basic auth and a JSON body, and parses the JSON reply", async () => {
    let seen: { auth?: string; type?: string; body?: string; method?: string; url?: string } = {};
    const base = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen = { auth: req.headers.authorization, type: req.headers["content-type"], body: Buffer.concat(chunks).toString("utf8"), method: req.method, url: req.url };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { id: "ses_1" } }));
      });
    });
    const client = new OpenCodeClient(base, "s3cret");
    // 中文与空格路径要原样到达（长度按字节算，不是按字符）。
    const reply = await client.request("POST", "/api/session", { location: { directory: "C:\\工作 目录" } });
    expect(reply).toEqual({ data: { id: "ses_1" } });
    expect(seen).toMatchObject({ auth: basic("s3cret"), type: "application/json", method: "POST", url: "/api/session" });
    expect(JSON.parse(seen.body ?? "")).toEqual({ location: { directory: "C:\\工作 目录" } });
  });

  it("returns undefined for an empty 204 reply", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    expect(await new OpenCodeClient(base, "p").request("DELETE", "/api/x")).toBeUndefined();
  });

  it("turns non-2xx replies into OpenCodeHttpError with a clipped, credential-free message", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Bad model. Authorization: Bearer abcdefgh12345678 was rejected" }));
    });
    const error = await new OpenCodeClient(base, "p").request("POST", "/api/session", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenCodeHttpError);
    expect((error as OpenCodeHttpError).status).toBe(400);
    expect((error as OpenCodeHttpError).message).toContain("Bad model");
    expect((error as OpenCodeHttpError).message).not.toContain("abcdefgh12345678");
  });

  it("still reports the status when the error body is not JSON", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(502);
      res.end("<html>bad gateway</html>");
    });
    const error = await new OpenCodeClient(base, "p").request("GET", "/api/x").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "OpenCodeHttpError", status: 502 });
  });

  it("times out instead of waiting forever on a silent server", async () => {
    const base = await listen(() => undefined);
    await expect(new OpenCodeClient(base, "p").request("GET", "/api/x", undefined, 120)).rejects.toThrow(/timed out/);
  });

  it("fails in-flight and later requests once failAll is called", async () => {
    const base = await listen(() => undefined);
    const client = new OpenCodeClient(base, "p");
    const pending = client.request("GET", "/api/x", undefined, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    client.failAll(new Error("session closed"));
    await expect(pending).rejects.toThrow("session closed");
    await expect(client.request("GET", "/api/y")).rejects.toThrow("session closed");
  });
});

describe("OpenCodeClient.subscribe", () => {
  it("parses frames split at arbitrary byte boundaries, CRLF line ends, comments and multi-byte text, and skips malformed frames", async () => {
    const payloads = [
      Buffer.from(frame("server.connected")),
      Buffer.from(": heartbeat\n\n"),
      Buffer.from(frame("session.text.delta", { delta: "你好，世界 ✓" }).replace(/\n/g, "\r\n")),
      Buffer.from("data: {not json}\n\n"),
      Buffer.from(`data: {"id":"e","type":"session.text.ended",\ndata: "data":{"text":"multi-line"}}\n\n`),
      Buffer.from(frame("session.execution.succeeded", { sessionID: "ses_1" })),
    ];
    const all = Buffer.concat(payloads);
    const base = await listen((req, res) => {
      expect(req.headers.accept).toBe("text/event-stream");
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 每次只写 5 个字节：必然把多字节字符与 \r\n 切开。
      let offset = 0;
      const timer = setInterval(() => {
        res.write(all.subarray(offset, offset + 5));
        offset += 5;
        if (offset >= all.length) {
          clearInterval(timer);
          res.end();
        }
      }, 1);
    });
    const events: OpenCodeEvent[] = [];
    let closed: { error: Error | undefined } | undefined;
    await new OpenCodeClient(base, "p").subscribe(
      (event) => events.push(event),
      (error) => (closed = { error }),
    );
    await until(() => closed !== undefined, 5_000, "stream end");
    expect(events.map((e) => e.type)).toEqual(["session.text.delta", "session.text.ended", "session.execution.succeeded"]);
    expect(events[0]?.data).toEqual({ delta: "你好，世界 ✓" });
    expect(events[1]?.data).toEqual({ text: "multi-line" });
    expect(closed?.error).toBeUndefined();
  });

  it("ignores anything before server.connected and resolves only once it arrives", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame("session.text.delta", { delta: "too early" }));
      setTimeout(() => res.write(frame("server.connected")), 60);
      setTimeout(() => res.write(frame("session.text.delta", { delta: "on time" })), 90);
    });
    const events: OpenCodeEvent[] = [];
    const client = new OpenCodeClient(base, "p");
    const started = Date.now();
    await client.subscribe((event) => events.push(event), () => undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    await until(() => events.length > 0, 2_000, "first event");
    expect(events.map((e) => e.data["delta"])).toEqual(["on time"]);
    client.failAll(new Error("done"));
  });

  it("rejects when the server refuses the credentials", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    await expect(new OpenCodeClient(base, "wrong").subscribe(() => undefined, () => undefined)).rejects.toMatchObject({ status: 401 });
  });

  it("reports a dropped connection to onClose, but not a deliberate failAll", async () => {
    const dropping = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame("server.connected"));
      setTimeout(() => res.destroy(), 40);
    });
    let dropped: { error: Error | undefined } | undefined;
    await new OpenCodeClient(dropping, "p").subscribe(() => undefined, (error) => (dropped = { error }));
    await until(() => dropped !== undefined, 2_000, "drop reported");
    expect(dropped?.error).toBeInstanceOf(Error);

    const steady = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame("server.connected"));
    });
    const client = new OpenCodeClient(steady, "p");
    let closes: Array<Error | undefined> = [];
    await client.subscribe(() => undefined, (error) => closes.push(error));
    client.failAll(new Error("session closed"));
    await until(() => closes.length > 0, 2_000, "close reported");
    expect(closes).toEqual([undefined]);
    closes = [];
  });
});
