import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { seedLinks } from "./seed.ts";

const db = openDatabase(process.env.DB_PATH || "data/origens.sqlite");
seedLinks(db);
const port = Number(process.env.PORT || 3006);
const windowDays = Number(process.env.ATTRIBUTION_WINDOW_DAYS || 7);

serve(
  {
    fetch: createApp({ db, windowDays, appOpenUrl: process.env.APP_OPEN_URL || "https://conty.app/abrir" }).fetch,
    port,
  },
  (info) => console.log(`origem do cadastro em http://127.0.0.1:${info.port} (janela de ${windowDays} dias)`),
);
