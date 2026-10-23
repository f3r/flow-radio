import { env } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const video = { kind: "video", ref: "abcdefghijk" } as const;
const other = { kind: "video", ref: "lmnopqrstuv" } as const;
let nextIp = 1;

async function call(path: string, data?: unknown) {
  const request = new Request(`https://pool.test${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { "CF-Connecting-IP": `192.0.2.${nextIp++}`, "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return worker.fetch(request, env);
}

function youtube(status = 200, title = "YouTube title") {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(status === 200 ? JSON.stringify({ title }) : null, { status })));
}

async function row(target = video) {
  return env.DB.prepare("SELECT * FROM stations WHERE kind = ? AND ref = ?")
    .bind(target.kind, target.ref).first<{ title: string; keeps: number; reports: number }>();
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM stations");
  youtube();
});
afterEach(() => vi.unstubAllGlobals());

describe("stations pool", () => {
  it("shares a station with the YouTube title and only stores one copy", async () => {
    expect((await call("/share", { ...video, title: "client title" })).status).toBe(204);
    expect((await row())?.title).toBe("YouTube title");
    expect((await call("/share", video)).status).toBe(204);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM stations").first<{ count: number }>();
    expect(count?.count).toBe(1);
    expect(fetch).toHaveBeenCalledWith(new URL("https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabcdefghijk"));
  });

  it("rejects invalid references and unavailable stations without storing them", async () => {
    expect((await call("/share", { kind: "video", ref: "short" })).status).toBe(400);
    youtube(404);
    expect((await call("/share", video)).status).toBe(422);
    expect(await row()).toBeNull();
  });

  it("returns 204 when random has no eligible station", async () => {
    expect((await call("/random")).status).toBe(204);
    await call("/share", video);
    expect((await call(`/random?kind=${video.kind}&ref=${video.ref}`)).status).toBe(204);
  });

  it("picks weighted slots with 1 + keeps", async () => {
    await call("/share", video);
    await call("/share", other);
    await env.DB.prepare("UPDATE stations SET keeps = 3 WHERE ref = ?").bind(other.ref).run();
    const random = vi.spyOn(Math, "random");
    for (let slot = 0; slot < 5; slot++) {
      random.mockReturnValue(slot / 5);
      const response = await call("/random");
      expect((await response.json() as { ref: string }).ref).toBe(slot === 0 ? video.ref : other.ref);
    }
    random.mockRestore();
  });

  it("increments keeps and accepts an absent station", async () => {
    expect((await call("/keep", video)).status).toBe(204);
    await call("/share", video);
    await call("/keep", video);
    expect((await row())?.keeps).toBe(1);
  });

  it("deletes a station immediately when oEmbed no longer knows it", async () => {
    await call("/share", video);
    youtube(404);
    expect((await call("/report", { ...video, code: 100 })).status).toBe(204);
    expect(await row()).toBeNull();
  });

  it("deletes a still-known station on its fifth report", async () => {
    await call("/share", video);
    for (let report = 1; report < 5; report++) {
      expect((await call("/report", { ...video, code: 150 })).status).toBe(204);
      expect((await row())?.reports).toBe(report);
    }
    expect((await call("/report", { ...video, code: 150 })).status).toBe(204);
    expect(await row()).toBeNull();
  });

  it("rejects unknown paths, invalid report codes and bodies over 1 KB", async () => {
    expect((await call("/unknown")).status).toBe(404);
    expect((await call("/report", { ...video, code: 99 })).status).toBe(400);
    expect((await call("/share", { ...video, padding: "x".repeat(1024) })).status).toBe(413);
  });
});
