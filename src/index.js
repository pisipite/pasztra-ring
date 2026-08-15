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
    if (request.method === "GET" && url.pathname === "/telegram-test") {
      const token = env.TELEGRAM_BOT_TOKEN || "";

      const diagnostics = {
        tokenExists: token.length > 0,
        tokenLength: token.length,
        containsWhitespace: /\s/.test(token),
        startsWithBot: token.startsWith("bot"),
        chatIdExists: Boolean(env.TELEGRAM_CHAT_ID)
      };

      // Token ellenőrzése
      const getMeResponse = await fetch(
        `https://api.telegram.org/bot${token}/getMe`
      );

      const getMe = await getMeResponse.json();

      if (!getMeResponse.ok || !getMe.ok) {
        return Response.json({
          status: "token_error",
          diagnostics,
          getMe
        });
      }

      // Tesztüzenet küldése
      const sendResponse = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: "🔔 Pasztra Ring teszt – működik!"
          })
        }
      );

      const sendResult = await sendResponse.json();

      return Response.json({
        status: sendResult.ok ? "ok" : "send_error",
        diagnostics,
        getMe: {
          ok: getMe.ok,
          username: getMe.result?.username
        },
        telegram: sendResult
      });
    }

    // Későbbi Ring webhook helye
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
