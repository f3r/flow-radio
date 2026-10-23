export interface Env {
  DB: D1Database;
  READS: RateLimit;
  WRITES: RateLimit;
}

type Station = { kind: "video" | "playlist"; ref: string };

const noContent = () => new Response(null, { status: 204 });
const error = (status: number, message: string) =>
  Response.json({ error: message }, { status });

function station(value: unknown): Station | null {
  if (!value || typeof value !== "object") return null;
  const { kind, ref } = value as Record<string, unknown>;
  if (kind === "video" && typeof ref === "string" && /^[\w-]{11}$/.test(ref)) return { kind, ref };
  if (kind === "playlist" && typeof ref === "string" && /^[\w-]{10,64}$/.test(ref)) return { kind, ref };
  return null;
}

async function body(request: Request): Promise<unknown | Response> {
  const length = Number(request.headers.get("content-length"));
  if (length > 1024) return error(413, "Body too large");
  if (!request.body) return error(400, "Invalid JSON");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) {
        await reader.cancel();
        return error(413, "Body too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error(400, "Invalid JSON");
  }
}

function oembedUrl({ kind, ref }: Station) {
  const canonical = kind === "video"
    ? `https://www.youtube.com/watch?v=${ref}`
    : `https://www.youtube.com/playlist?list=${ref}`;
  const url = new URL("https://www.youtube.com/oembed");
  url.searchParams.set("format", "json");
  url.searchParams.set("url", canonical);
  return url;
}

async function lookup(station: Station): Promise<Response> {
  return fetch(oembedUrl(station));
}

async function random(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const ref = url.searchParams.get("ref");
  const excluded = kind === null && ref === null ? null : station({ kind, ref });
  if ((kind !== null || ref !== null) && !excluded) return error(400, "Invalid station");
  const params = [excluded?.kind ?? "", excluded?.ref ?? ""];
  const where = "WHERE NOT (kind = ? AND ref = ?)";
  const total = await env.DB.prepare(`SELECT SUM(1 + keeps) AS weight FROM stations ${where}`)
    .bind(...params).first<{ weight: number | null }>();
  if (!total?.weight) return noContent();
  const slot = Math.floor(Math.random() * total.weight);
  const picked = await env.DB.prepare(`
    SELECT kind, ref, title FROM (
      SELECT kind, ref, title, SUM(1 + keeps) OVER (ORDER BY rowid) AS cumulative
      FROM stations ${where}
    ) WHERE cumulative > ? ORDER BY cumulative LIMIT 1
  `).bind(...params, slot).first<{ kind: Station["kind"]; ref: string; title: string }>();
  return picked ? Response.json(picked) : noContent();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    const read = request.method === "GET" && path === "/random";
    const write = request.method === "POST" && ["/share", "/keep", "/report"].includes(path);
    if (!read && !write) return error(404, "Not found");

    const limiter = read ? env.READS : env.WRITES;
    const { success } = await limiter.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" });
    if (!success) return error(429, "Too many requests");
    if (read) return random(request, env);

    const data = await body(request);
    if (data instanceof Response) return data;
    const target = station(data);
    if (!target) return error(400, "Invalid station");

    if (path === "/keep") {
      await env.DB.prepare("UPDATE stations SET keeps = keeps + 1 WHERE kind = ? AND ref = ?")
        .bind(target.kind, target.ref).run();
      return noContent();
    }

    if (path === "/report" && (![100, 101, 150].includes((data as { code?: number }).code ?? 0))) {
      return error(400, "Invalid report code");
    }

    let response: Response;
    try {
      response = await lookup(target);
    } catch {
      return error(502, "YouTube unavailable");
    }

    if (path === "/share") {
      if (response.status !== 200) return error(422, "Station unavailable");
      let title: unknown;
      try {
        title = (await response.json() as { title?: unknown }).title;
      } catch {
        return error(502, "Invalid YouTube response");
      }
      if (typeof title !== "string" || !title) return error(502, "Invalid YouTube response");
      await env.DB.prepare(`
        INSERT INTO stations (kind, ref, title, added_at) VALUES (?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).bind(target.kind, target.ref, title.slice(0, 200), Date.now()).run();
      return noContent();
    }

    if (response.status !== 200) {
      await env.DB.prepare("DELETE FROM stations WHERE kind = ? AND ref = ?")
        .bind(target.kind, target.ref).run();
    } else {
      await env.DB.prepare(`
        UPDATE stations SET reports = reports + 1 WHERE kind = ? AND ref = ?
      `).bind(target.kind, target.ref).run();
      await env.DB.prepare("DELETE FROM stations WHERE kind = ? AND ref = ? AND reports >= 5")
        .bind(target.kind, target.ref).run();
    }
    return noContent();
  },
} satisfies ExportedHandler<Env>;
