export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Egyszerű ellenőrzés, hogy él-e a Worker
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        status: "ok",
        service: "pasztra-ring"
      });
    }

    // Ring webhook - ezt a következő lépésben építjük ki
    if (request.method === "POST" && url.pathname === "/ring/webhook") {
      return Response.json({
        received: true
      });
    }

    return new Response("Not found", {
      status: 404
    });
  }
};
