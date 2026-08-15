export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        status: "ok",
        service: "pasztra-ring"
      });
    }

    // Telegram teszt
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
  return Response.json(
    {
      status: "error",
      hasToken: Boolean(env.TELEGRAM_BOT_TOKEN),
      hasChatId: Boolean(env.TELEGRAM_CHAT_ID)
    },
    { status: 500 }
  );
}
    if (request.method === "GET" && url.pathname === "/telegram-test") {
      try {
        const telegramUrl =
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

        const response = await fetch(telegramUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: "🔔 Pasztra Ring teszt – működik!"
          })
        });

        const result = await response.json();

        if (!response.ok || !result.ok) {
          return Response.json(
            {
              status: "error",
              telegram: result
            },
            { status: 500 }
          );
        }

        return Response.json({
          status: "ok",
          message: "Telegram message sent"
        });

      } catch (error) {
        return Response.json(
          {
            status: "error",
            message: error.message
          },
          { status: 500 }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  }
};
