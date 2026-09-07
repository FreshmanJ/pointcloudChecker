const APP_PREFIX = "/pointcloudChecker";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === APP_PREFIX) {
      url.pathname = `${APP_PREFIX}/`;
      return Response.redirect(url.toString(), 308);
    }

    if (!url.pathname.startsWith(`${APP_PREFIX}/`)) {
      return new Response("Not Found", { status: 404 });
    }

    url.pathname = url.pathname.slice(APP_PREFIX.length) || "/";
    return env.ASSETS.fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
