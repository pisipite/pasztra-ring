const RING_API = "https://api.amazonvision.com";
const RING_OAUTH = "https://oauth.ring.com/oauth/token";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Egyszerű kezdőlap
    if (request.method === "GET" && url.pathname === "/") {
      return html(`
        <!doctype html>
        <html lang="hu">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>Pasztra Ring</title>
        </head>
        <body style="font-family:system-ui;max-width:700px;margin:40px auto;padding:0 20px">
          <h1>Pasztra Ring</h1>
          <p>Worker: <strong>OK</strong></p>
        </body>
        </html>
      `);
    }

    // Debug: utolsó Ring webhook
    if (request.method === "GET" && url.pathname === "/debug/last-webhook") {
      const authorized = await checkBasicAuth(request, env);

      if (!authorized) {
        return new Response("Authentication required", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Pasztra Ring"'
          }
        });
      }

      const value = await env.RING_STORE.get("last_webhook");

      return json({
        last_webhook: value ? JSON.parse(value) : null
      });
    }

    // Biztonságos diagnosztika
    if (request.method === "GET" && url.pathname === "/health") {
      let db = false;

      try {
        await env.DB.prepare("SELECT 1").first();
        db = true;
      } catch {}

      return json({
        worker: true,
        db,
        kv: Boolean(env.RING_STORE),
        telegram: Boolean(
          env.TELEGRAM_BOT_TOKEN &&
          env.TELEGRAM_CHAT_ID
        ),
        ring: Boolean(
          env.RING_CLIENT_ID &&
          env.RING_CLIENT_SECRET &&
          env.RING_HMAC_KEY
        ),
        linkLogin: Boolean(
          env.LINK_USERNAME &&
          env.LINK_PASSWORD
        )
      });
    }

    // Ring backend ide küldi az OAuth authorization code-ot
    if (request.method === "POST" && url.pathname === "/ring/token") {
      return handleTokenExchange(request, env);
    }

    // Ring ide irányítja a böngészőt account linkingnél
    if (request.method === "GET" && url.pathname === "/ring/link") {
      return showLinkForm(url);
    }

    if (request.method === "POST" && url.pathname === "/ring/link") {
      return handleLinkForm(request, env);
    }

    // Ring webhook
    if (request.method === "POST" && url.pathname === "/ring/webhook") {
      return handleRingWebhook(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  }
};


/* =========================================================
   TOKEN EXCHANGE
   ========================================================= */

async function handleTokenExchange(request, env) {
  if (!env.DB || !env.RING_CLIENT_ID || !env.RING_CLIENT_SECRET) {
    return json({
      ok: false,
      error: "Server configuration incomplete"
    }, 500);
  }

  const code = await extractAuthorizationCode(request);

  if (!code) {
    return json({
      ok: false,
      error: "Missing authorization code"
    }, 400);
  }

  const response = await fetch(RING_OAUTH, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.RING_CLIENT_ID,
      client_secret: env.RING_CLIENT_SECRET,
      code
    })
  });

  if (!response.ok) {
    return json({
      ok: false,
      error: "Ring token exchange failed",
      status: response.status
    }, 502);
  }

  const tokens = await response.json();

  if (!tokens.access_token || !tokens.refresh_token) {
    return json({
      ok: false,
      error: "Incomplete token response"
    }, 502);
  }

  // A Ring account ID-t külön API-hívással kell lekérni
  const profile = await getRingProfile(tokens.access_token);

  if (!profile?.data?.id) {
    return json({
      ok: false,
      error: "Could not retrieve Ring account"
    }, 502);
  }

  const accountId = profile.data.id;

  const now = Date.now();

  const expiresAt =
    now + Number(tokens.expires_in || 14400) * 1000;

  await env.DB.prepare(`
    INSERT INTO ring_accounts (
      account_id,
      access_token,
      refresh_token,
      token_expires_at,
      scope,
      status,
      ring_email,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'unclaimed', NULL, ?, ?)

    ON CONFLICT(account_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_expires_at = excluded.token_expires_at,
      scope = excluded.scope,
      status = 'unclaimed',
      updated_at = excluded.updated_at
  `).bind(
    accountId,
    tokens.access_token,
    tokens.refresh_token,
    expiresAt,
    tokens.scope || null,
    now,
    now
  ).run();

  return json({ ok: true });
}


async function extractAuthorizationCode(request) {
  const url = new URL(request.url);

  const queryCode =
    url.searchParams.get("code") ||
    url.searchParams.get("authorization_code");

  if (queryCode) return queryCode;

  const type =
    request.headers.get("content-type") || "";

  try {
    if (type.includes("application/json")) {
      const body = await request.json();

      return (
        body?.code ||
        body?.authorization_code ||
        body?.authorizationCode ||
        body?.data?.attributes?.code ||
        null
      );
    }

    if (
      type.includes("application/x-www-form-urlencoded") ||
      type.includes("multipart/form-data")
    ) {
      const form = await request.formData();

      return (
        form.get("code") ||
        form.get("authorization_code") ||
        null
      );
    }

    const text = await request.text();

    if (!text) return null;

    const params = new URLSearchParams(text);

    return (
      params.get("code") ||
      params.get("authorization_code") ||
      null
    );

  } catch {
    return null;
  }
}


async function getRingProfile(accessToken) {
  for (let i = 0; i < 3; i++) {

    const response = await fetch(
      `${RING_API}/v1/users/me`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (response.ok) {
      return response.json();
    }

    if (response.status < 500) {
      return null;
    }

    await sleep(500 * (i + 1));
  }

  return null;
}


/* =========================================================
   ACCOUNT LINKING
   ========================================================= */

function showLinkForm(url) {
  const nonce =
    url.searchParams.get("nonce") || "";

  const time =
    url.searchParams.get("time") || "";

  if (!nonce || !time) {
    return html(
      "<h1>Hibás Ring összekapcsolási kérés</h1>",
      400
    );
  }

  const timestamp = Number(time);
  const age = Date.now() - timestamp;

  if (
    !Number.isFinite(timestamp) ||
    age < 0 ||
    age > 600000
  ) {
    return html(`
      <h1>Lejárt összekapcsolási kérés</h1>
      <p>Indítsd újra a Ring alkalmazásból.</p>
    `, 400);
  }

  return html(`
    <!doctype html>
    <html lang="hu">

    <head>
      <meta charset="utf-8">
      <meta name="viewport"
            content="width=device-width,initial-scale=1">

      <title>Pasztra Ring</title>
    </head>

    <body style="
      font-family:system-ui;
      max-width:420px;
      margin:40px auto;
      padding:0 20px
    ">

      <h1>Pasztra Ring</h1>

      <p>
        Jelentkezz be a Ring összekapcsolás
        befejezéséhez.
      </p>

      <form method="post" action="/ring/link">

        <input
          type="hidden"
          name="nonce"
          value="${escapeHtml(nonce)}"
        >

        <input
          type="hidden"
          name="time"
          value="${escapeHtml(time)}"
        >

        <label>
          Felhasználónév<br>
          <input
            name="username"
            autocomplete="username"
            required
            style="width:100%;padding:10px;margin:6px 0 14px"
          >
        </label>

        <br>

        <label>
          Jelszó<br>
          <input
            type="password"
            name="password"
            autocomplete="current-password"
            required
            style="width:100%;padding:10px;margin:6px 0 18px"
          >
        </label>

        <br>

        <button
          type="submit"
          style="padding:10px 16px"
        >
          Összekapcsolás
        </button>

      </form>

    </body>
    </html>
  `);
}


async function handleLinkForm(request, env) {

  if (
    !env.DB ||
    !env.RING_HMAC_KEY ||
    !env.LINK_USERNAME ||
    !env.LINK_PASSWORD
  ) {
    return html(
      "<h1>Szerverbeállítási hiba</h1>",
      500
    );
  }

  const form = await request.formData();

  const username =
    String(form.get("username") || "");

  const password =
    String(form.get("password") || "");

  const nonce =
    String(form.get("nonce") || "");

  const time =
    String(form.get("time") || "");


  const usernameOK =
    await secureEqual(
      username,
      env.LINK_USERNAME
    );

  const passwordOK =
    await secureEqual(
      password,
      env.LINK_PASSWORD
    );


  if (!usernameOK || !passwordOK) {
    return html(`
      <h1>Sikertelen bejelentkezés</h1>
      <p>Hibás felhasználónév vagy jelszó.</p>
    `, 401);
  }


  const timestamp = Number(time);
  const age = Date.now() - timestamp;

  if (
    !nonce ||
    !Number.isFinite(timestamp) ||
    age < 0 ||
    age > 600000
  ) {
    return html(`
      <h1>Lejárt vagy hibás kérés</h1>
      <p>Indítsd újra az összekapcsolást.</p>
    `, 400);
  }


  // Keressük azt az unclaimed Ring-fiókot,
  // amelynek Account ID-jával egyezik a nonce.

  const rows = await env.DB.prepare(`
    SELECT
      account_id,
      access_token,
      refresh_token,
      token_expires_at,
      scope

    FROM ring_accounts

    WHERE status = 'unclaimed'
  `).all();


  let matched = null;


  for (const row of rows.results || []) {

    const calculated =
      await calculateNonce(
        time,
        row.account_id,
        env.RING_HMAC_KEY
      );

    if (await secureEqual(calculated, nonce)) {
      matched = row;
      break;
    }
  }


  if (!matched) {
    return html(`
      <h1>Nem található Ring-fiók</h1>
      <p>Indítsd újra az összekapcsolást.</p>
    `, 400);
  }


  const accessToken =
    await getValidAccessToken(
      env,
      matched
    );


  if (!accessToken) {
    return html(`
      <h1>Ring hitelesítési hiba</h1>
      <p>Az összekapcsolást újra kell indítani.</p>
    `, 502);
  }


  const identifier =
    maskIdentifier(env.LINK_USERNAME);

  const body = { nonce };

  if (identifier) {
    body.account_identifier = identifier;
  }


  // 1. nonce visszaigazolása Ring felé

  const confirm = await fetch(
    `${RING_API}/v1/accounts/me/app-integrations`,
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${accessToken}`,

        "Content-Type":
          "application/json"
      },

      body: JSON.stringify(body)
    }
  );


  if (!confirm.ok) {
    return html(`
      <h1>A Ring nem fogadta el az összekapcsolást</h1>
      <p>HTTP ${confirm.status}</p>
    `, 502);
  }


  // 2. completed állapot kötelező

  const complete = await fetch(
    `${RING_API}/v1/accounts/me/app-integrations`,
    {
      method: "PATCH",

      headers: {
        Authorization:
          `Bearer ${accessToken}`,

        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        status: "completed"
      })
    }
  );


  if (!complete.ok) {
    return html(`
      <h1>Nem sikerült befejezni az összekapcsolást</h1>
      <p>HTTP ${complete.status}</p>
    `, 502);
  }


  await env.DB.prepare(`
    UPDATE ring_accounts

    SET
      status = 'completed',
      updated_at = ?

    WHERE account_id = ?
  `).bind(
    Date.now(),
    matched.account_id
  ).run();


  return html(`
    <!doctype html>
    <html lang="hu">
    <head>
      <meta charset="utf-8">
      <meta
        name="viewport"
        content="width=device-width,initial-scale=1"
      >
      <title>Sikeres összekapcsolás</title>
    </head>

    <body style="
      font-family:system-ui;
      max-width:520px;
      margin:40px auto;
      padding:0 20px
    ">

      <h1>✅ Sikeres összekapcsolás</h1>

      <p>
        A Ring-fiók össze lett kapcsolva
        a Pasztra Ring szolgáltatással.
      </p>

      <p>
        Visszatérhetsz a Ring alkalmazásba.
      </p>

    </body>
    </html>
  `);
}


/* =========================================================
   WEBHOOK
   ========================================================= */

async function handleRingWebhook(
  request,
  env,
  ctx
) {

  if (!env.RING_HMAC_KEY) {
    return json({
      ok: false,
      error: "Missing HMAC key"
    }, 500);
  }


  // FONTOS: a nyers body alapján kell ellenőrizni
  // a Ring HMAC aláírását.

  const rawBody =
    await request.arrayBuffer();

  const signature =
    request.headers.get("X-Signature") || "";


  const valid =
    await verifyWebhookSignature(
      rawBody,
      signature,
      env.RING_HMAC_KEY
    );


  if (!valid) {
    return json({
      ok: false,
      error: "Invalid signature"
    }, 401);
  }


  let payload;

  try {
    payload = JSON.parse(
      new TextDecoder().decode(rawBody)
    );
  } catch {
    return json({
      ok: false,
      error: "Invalid JSON"
    }, 400);
  }


  // Gyorsan válaszolunk Ringnek,
  // a feldolgozás a háttérben folytatódik.

  ctx.waitUntil(
    processWebhook(payload, env)
  );


  return json({ ok: true });
}


async function processWebhook(payload, env) {

  await env.RING_STORE.put(
    "last_webhook",
    JSON.stringify({
      received_at: Date.now(),
      type: payload?.data?.type || null,
      subtype: payload?.data?.subType || null,
      account_id: payload?.meta?.account_id || null,
      device_id: payload?.data?.attributes?.source || null
    })
  );

  const requestId =
    payload?.meta?.request_id;

  const type =
    payload?.data?.type;


  // Duplikált webhookok szűrése

  if (
    requestId &&
    env.RING_STORE
  ) {

    const key =
      `webhook:${requestId}`;

    const exists =
      await env.RING_STORE.get(key);

    if (exists) return;


    await env.RING_STORE.put(
      key,
      "1",
      {
        expirationTtl: 86400
      }
    );
  }


  if (type === "motion_detected") {
    await processMotion(
      payload,
      env
    );

    return;
  }


  if (type === "app_integration_removed") {

    const accountId =
      payload?.meta?.account_id;

    if (accountId) {

      await env.DB.prepare(`
        DELETE FROM ring_accounts
        WHERE account_id = ?
      `).bind(accountId).run();

    }
  }
}


/* =========================================================
   MOTION → IMAGE → TELEGRAM
   ========================================================= */

async function processMotion(payload, env) {

  const accountId =
    payload?.meta?.account_id;

  const deviceId =
    payload?.data?.attributes?.source;

  const timestamp =
    Number(
      payload?.data?.attributes?.timestamp
    );

  const subtype =
    payload?.data?.subType || "motion";


  if (
    !accountId ||
    !deviceId ||
    !Number.isFinite(timestamp)
  ) {
    return;
  }


  const account =
    await env.DB.prepare(`
      SELECT
        account_id,
        access_token,
        refresh_token,
        token_expires_at,
        scope

      FROM ring_accounts

      WHERE
        account_id = ?
        AND status = 'completed'
    `).bind(accountId).first();


  if (!account) return;


  const accessToken =
    await getValidAccessToken(
      env,
      account
    );


  if (!accessToken) return;


  const image =
    await downloadMotionImage(
      deviceId,
      timestamp,
      accessToken
    );


  const when =
    formatBudapestTime(timestamp);


  const caption =
    `🚨 Ring mozgás\n${when}\nTípus: ${subtype}`;


  if (image) {

    await sendTelegramPhoto(
      env,
      image.data,
      image.contentType,
      caption
    );

  } else {

    await sendTelegramMessage(
      env,
      `${caption}\nA kép nem volt elérhető.`
    );

  }
}


async function downloadMotionImage(
  deviceId,
  timestamp,
  accessToken
) {

  const url =
    `${RING_API}/v1/devices/` +
    `${encodeURIComponent(deviceId)}` +
    `/media/image/download`;


  // Recording közvetlenül motion után
  // még lehet feldolgozás alatt.

  const delays = [
    0,
    2000,
    4000,
    8000
  ];


  for (const delay of delays) {

    if (delay) {
      await sleep(delay);
    }


    const response =
      await fetch(
        url,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            type: "at_timestamp",

            timestamp,

            image_options: {
              format: "jpeg"
            }
          }),

          redirect: "follow"
        }
      );


    if (response.ok) {

      return {
        data:
          await response.arrayBuffer(),

        contentType:
          response.headers.get(
            "content-type"
          ) || "image/jpeg"
      };

    }


    // 425 = recording még nincs kész
    // 5xx = ideiglenes szerverhiba

    if (
      response.status !== 425 &&
      response.status < 500
    ) {
      return null;
    }
  }


  return null;
}


/* =========================================================
   TOKEN REFRESH
   ========================================================= */

async function getValidAccessToken(
  env,
  account
) {

  // 5 perccel lejárat előtt frissítünk

  if (
    Date.now() <
    Number(account.token_expires_at) -
    300000
  ) {

    return account.access_token;
  }


  const response =
    await fetch(
      RING_OAUTH,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body: new URLSearchParams({
          grant_type: "refresh_token",

          refresh_token:
            account.refresh_token,

          client_id:
            env.RING_CLIENT_ID,

          client_secret:
            env.RING_CLIENT_SECRET
        })
      }
    );


  if (!response.ok) {
    return null;
  }


  const tokens =
    await response.json();


  if (
    !tokens.access_token ||
    !tokens.refresh_token
  ) {
    return null;
  }


  const expiresAt =
    Date.now() +
    Number(tokens.expires_in || 14400) *
    1000;


  await env.DB.prepare(`
    UPDATE ring_accounts

    SET
      access_token = ?,
      refresh_token = ?,
      token_expires_at = ?,
      scope = ?,
      updated_at = ?

    WHERE account_id = ?
  `).bind(
    tokens.access_token,
    tokens.refresh_token,
    expiresAt,
    tokens.scope || account.scope || null,
    Date.now(),
    account.account_id
  ).run();


  return tokens.access_token;
}


/* =========================================================
   TELEGRAM
   ========================================================= */

async function sendTelegramPhoto(
  env,
  data,
  contentType,
  caption
) {

  const form =
    new FormData();


  form.append(
    "chat_id",
    env.TELEGRAM_CHAT_ID
  );


  form.append(
    "caption",
    caption
  );


  form.append(
    "photo",
    new Blob(
      [data],
      { type: contentType }
    ),
    "ring.jpg"
  );


  await fetch(
    `https://api.telegram.org/` +
    `bot${env.TELEGRAM_BOT_TOKEN}` +
    `/sendPhoto`,
    {
      method: "POST",
      body: form
    }
  );
}


async function sendTelegramMessage(
  env,
  text
) {

  await fetch(
    `https://api.telegram.org/` +
    `bot${env.TELEGRAM_BOT_TOKEN}` +
    `/sendMessage`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        chat_id:
          env.TELEGRAM_CHAT_ID,

        text
      })
    }
  );
}


/* =========================================================
   CRYPTO
   ========================================================= */

async function calculateNonce(
  time,
  accountId,
  hmacKey
) {

  const key =
    await crypto.subtle.importKey(
      "raw",

      new TextEncoder()
        .encode(hmacKey),

      {
        name: "HMAC",
        hash: "SHA-256"
      },

      false,

      ["sign"]
    );


  const signature =
    await crypto.subtle.sign(
      "HMAC",

      key,

      new TextEncoder()
        .encode(`${time}:${accountId}`)
    );


  return base64UrlNoPadding(
    new Uint8Array(signature)
  );
}


async function verifyWebhookSignature(
  rawBody,
  receivedSignature,
  hmacKey
) {

  if (!receivedSignature) {
    return false;
  }


  const key =
    await crypto.subtle.importKey(
      "raw",

      new TextEncoder()
        .encode(hmacKey),

      {
        name: "HMAC",
        hash: "SHA-256"
      },

      false,

      ["sign"]
    );


  const signature =
    await crypto.subtle.sign(
      "HMAC",
      key,
      rawBody
    );


  const expected =
    bytesToHex(
      new Uint8Array(signature)
    );


  const received =
    receivedSignature
      .replace(/^sha256=/i, "")
      .toLowerCase();


  return secureEqual(
    expected.toLowerCase(),
    received
  );
}


async function secureEqual(a, b) {

  const encoder =
    new TextEncoder();


  const [hashA, hashB] =
    await Promise.all([

      crypto.subtle.digest(
        "SHA-256",
        encoder.encode(String(a))
      ),

      crypto.subtle.digest(
        "SHA-256",
        encoder.encode(String(b))
      )

    ]);


  const A =
    new Uint8Array(hashA);

  const B =
    new Uint8Array(hashB);


  let diff = 0;


  for (
    let i = 0;
    i < A.length;
    i++
  ) {

    diff |= A[i] ^ B[i];

  }


  return diff === 0;
}


/* =========================================================
   HELPERS
   ========================================================= */

function base64UrlNoPadding(bytes) {

  let binary = "";

  for (const byte of bytes) {
    binary +=
      String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}


function bytesToHex(bytes) {

  return Array.from(
    bytes,
    byte =>
      byte
        .toString(16)
        .padStart(2, "0")
  ).join("");
}


function maskIdentifier(value) {

  const text =
    String(value || "");

  const at =
    text.indexOf("@");

  if (at <= 0) {
    return null;
  }


  const local =
    text.slice(0, at);

  const domain =
    text.slice(at + 1);


  const masked =
    local.length <= 1
      ? "*"
      : `${local[0]}***${local[local.length - 1]}`;


  return `${masked}@${domain}`;
}


function formatBudapestTime(timestamp) {

  return new Intl.DateTimeFormat(
    "hu-HU",
    {
      timeZone:
        "Europe/Budapest",

      year: "numeric",
      month: "2-digit",
      day: "2-digit",

      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }
  ).format(
    new Date(timestamp)
  );
}


function escapeHtml(value) {

  return String(value)

    .replaceAll(
      "&",
      "&amp;"
    )

    .replaceAll(
      "<",
      "&lt;"
    )

    .replaceAll(
      ">",
      "&gt;"
    )

    .replaceAll(
      "\"",
      "&quot;"
    )

    .replaceAll(
      "'",
      "&#039;"
    );
}


function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}


function json(data, status = 200) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}


function html(body, status = 200) {

  return new Response(
    body,
    {
      status,

      headers: {
        "Content-Type":
          "text/html; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}
async function checkBasicAuth(request, env) {
  const header =
    request.headers.get("Authorization") || "";

  if (!header.startsWith("Basic ")) {
    return false;
  }

  try {
    const decoded =
      atob(header.slice(6));

    const separator =
      decoded.indexOf(":");

    if (separator < 0) {
      return false;
    }

    const username =
      decoded.slice(0, separator);

    const password =
      decoded.slice(separator + 1);

    const usernameOK =
      await secureEqual(
        username,
        env.LINK_USERNAME
      );

    const passwordOK =
      await secureEqual(
        password,
        env.LINK_PASSWORD
      );

    return usernameOK && passwordOK;

  } catch {
    return false;
  }
}
