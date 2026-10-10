import type { DatabaseSync } from "node:sqlite";
import { type Context, Hono } from "hono";
import { type Clock, systemClock } from "./clock.ts";
import { DomainError } from "./errors.ts";
import { createOriginService } from "./origins.ts";

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new DomainError("json_invalido", "O corpo precisa ser um JSON válido.", 400);
  }
}

export function createApp({
  db,
  clock = systemClock,
  windowDays = 7,
  appOpenUrl = "https://conty.app/abrir",
}: {
  db: DatabaseSync;
  clock?: Clock;
  /** Janela de validade da origem, em dias, contada da primeira abertura do app. */
  windowDays?: number;
  /** Para onde o redirecionador manda (deep link / universal link do app). */
  appOpenUrl?: string;
}) {
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new Error(`janela de validade inválida: ${windowDays} (use um número inteiro de dias, 1 ou mais)`);
  }
  const origins = createOriginService({ db, clock, windowDays, appOpenUrl });
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof DomainError) return c.json(error.toJSON(), error.status);
    console.error(error);
    return c.json({ error: "erro_interno", message: "Erro inesperado." }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, window_days: windowDays }));

  // Marketing
  app.post("/links", async (c) => c.json(origins.createLink(await readJson(c)), 201));

  // Link público. Não depende de referrer: o que importa vai na URL de destino.
  app.get("/l/:code", (c) => c.redirect(origins.click(c.req.param("code")).location, 302));

  // App
  app.post("/app/opens", async (c) => c.json(origins.recordOpen(await readJson(c))));
  app.post("/signups", async (c) => {
    const out = origins.signup(await readJson(c));
    return c.json(out.signup, out.created ? 201 : 200);
  });

  // Auditoria
  app.get("/signups/:userId", (c) => c.json(origins.getSignup(c.req.param("userId"))));
  app.get("/devices/:deviceId", (c) => c.json(origins.getDevice(c.req.param("deviceId"))));

  return app;
}
