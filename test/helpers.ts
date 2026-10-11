import { createApp } from "../src/app.ts";
import type { Decision } from "../src/attribution.ts";
import { openDatabase } from "../src/db.ts";

export type SignupView = Decision & { user_id: string; device_id: string; signed_up_at: string };

export const DAY = 24 * 60 * 60 * 1000;

export function setup(options: { windowDays?: number } = {}) {
  let current = new Date("2026-03-02T15:00:00.000Z");
  const db = openDatabase(":memory:");
  const app = createApp({
    db,
    clock: { now: () => new Date(current) },
    windowDays: options.windowDays ?? 7,
    appOpenUrl: "https://conty.app/abrir",
  });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  return {
    app,
    db,
    post,
    get: (path: string) => app.request(path),
    now: () => current.toISOString(),
    setNow(iso: string) {
      current = new Date(iso);
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    async seedLinks() {
      for (const link of [
        { code: "cmp-verao26-ig", type: "campaign", ref: "cmp_verao26" },
        { code: "cmp-verao26-tiktok", type: "campaign", ref: "cmp_verao26" },
        { code: "ind-ana", type: "referral", ref: "crt_ana" },
        { code: "com-ugc-sp", type: "community", ref: "grp_ugc_sp" },
      ]) {
        const res = await post("/links", link);
        if (res.status !== 201) throw new Error(`link não criado: ${res.status}`);
      }
    },
    /** Simula o clique: passa pelo redirecionador e devolve o que viaja na URL do app. */
    async click(code: string) {
      const res = await app.request(`/l/${code}`);
      const location = new URL(res.headers.get("location") ?? "");
      return {
        status: res.status,
        location,
        link: location.searchParams.get("link"),
        click: location.searchParams.get("click"),
      };
    },
    async open(deviceId: string, link?: string | null, click?: string | null) {
      const res = await post("/app/opens", { device_id: deviceId, link: link ?? undefined, click: click ?? undefined });
      return (await res.json()) as {
        first_open: boolean;
        first_open_at: string;
        window_ends_at: string;
        touch: null | {
          touch_id: number;
          click_id: string;
          click_id_source: string;
          duplicate: boolean;
          after_signup: boolean;
        };
        touch_error?: string;
        click_warning?: string;
      };
    },
    async signup(userId: string, deviceId: string) {
      const res = await post("/signups", { user_id: userId, device_id: deviceId });
      return { status: res.status, body: (await res.json()) as SignupView };
    },
  };
}
