const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export function extname(path: string): string {
  const i = path.lastIndexOf(".");
  if (i <= 0) return "";
  return path.slice(i);
}

export function resolveConsolePath(staticDir: string, pathname: string): { file: string; isIndex: boolean } | null {
  const rel = pathname.replace(/^\/console\/?/, "");
  if (rel.includes("..")) return null;
  if (!rel || extname(rel) === "") return { file: `${staticDir}/index.html`, isIndex: true };
  return { file: `${staticDir}/${rel}`, isIndex: false };
}

export function consoleFileResponse(file: string, isIndex: boolean): Promise<Response> {
  const mime = MIME[extname(file)] ?? "application/octet-stream";
  return Bun.file(file)
    .exists()
    .then((exists) => {
      if (!exists) return json404();
      return new Response(Bun.file(file), {
        headers: {
          "Content-Type": mime,
          "Cache-Control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
        },
      });
    });
}

function json404(): Response {
  return Response.json({ error: { message: "not found", type: "gateway_error", code: 404 } }, { status: 404 });
}

export function consoleRoutes(staticDir: string) {
  return (pathname: string): Response | Promise<Response> => {
    const resolved = resolveConsolePath(staticDir, pathname);
    if (!resolved) return json404();
    return consoleFileResponse(resolved.file, resolved.isIndex);
  };
}