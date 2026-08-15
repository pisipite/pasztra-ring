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

    // Telegram tesztif (request.method === "GET" && url.pathname === "/telegram-test") {

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

  return Response.json({
    status: response.ok ? "ok" : "error",
    telegram: result
  });
}
