import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type Decision, decideOrigin, type OriginType, type Touch } from "./attribution.ts";
import type { Clock } from "./clock.ts";
import { DomainError } from "./errors.ts";

type LinkRow = { code: string; type: OriginType; ref: string; label: string | null; created_at: string };
type DeviceRow = { device_id: string; first_open_at: string };
type TouchRow = {
  id: number;
  device_id: string;
  click_id: string;
  click_id_source: "link" | "derived";
  link_code: string;
  recorded_at: string;
  type: OriginType;
  ref: string;
};
type SignupRow = {
  user_id: string;
  device_id: string;
  signed_up_at: string;
  origin_type: OriginType | "organic";
  origin_ref: string | null;
  winning_touch_id: number | null;
  reason: string;
  decision: string;
};

const ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
const LINK_CODE_RE = /^[a-z0-9-]{3,60}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function text(input: unknown, name: string): unknown {
  return input && typeof input === "object" ? (input as Record<string, unknown>)[name] : undefined;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new DomainError(
      "campo_invalido",
      `${field} é obrigatório (4 a 80 caracteres: letras, números, _ ou -).`,
      422,
    );
  }
  return value;
}

export function createOriginService({
  db,
  clock,
  windowDays,
  appOpenUrl,
  newId = () => crypto.randomUUID(),
}: {
  db: DatabaseSync;
  clock: Clock;
  windowDays: number;
  appOpenUrl: string;
  newId?: () => string;
}) {
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const link = (code: string) => db.prepare("SELECT * FROM links WHERE code = ?").get(code) as LinkRow | undefined;
  const device = (id: string) =>
    db.prepare("SELECT * FROM devices WHERE device_id = ?").get(id) as DeviceRow | undefined;
  const touchesOf = (deviceId: string) =>
    db
      .prepare(
        `SELECT t.*, l.type, l.ref FROM touches t JOIN links l ON l.code = t.link_code
          WHERE t.device_id = ? ORDER BY t.recorded_at, t.id`,
      )
      .all(deviceId) as TouchRow[];

  function windowEnd(firstOpenAt: string): string {
    return new Date(new Date(firstOpenAt).getTime() + windowDays * DAY_MS).toISOString();
  }

  function touchView(t: TouchRow) {
    return {
      touch_id: t.id,
      link: t.link_code,
      type: t.type,
      ref: t.ref,
      click_id: t.click_id,
      click_id_source: t.click_id_source,
      recorded_at: t.recorded_at,
    };
  }

  function signupView(row: SignupRow) {
    const decision = JSON.parse(row.decision) as Decision;
    return { user_id: row.user_id, device_id: row.device_id, signed_up_at: row.signed_up_at, ...decision };
  }

  return {
    createLink(input: unknown) {
      const code = text(input, "code");
      const type = text(input, "type");
      const ref = text(input, "ref");
      const label = text(input, "label");
      if (typeof code !== "string" || !LINK_CODE_RE.test(code)) {
        throw new DomainError("link_invalido", "code: 3 a 60 caracteres, minúsculas, números ou -.", 422);
      }
      if (type !== "campaign" && type !== "referral" && type !== "community") {
        throw new DomainError("link_invalido", "type precisa ser campaign, referral ou community.", 422);
      }
      if (typeof ref !== "string" || ref.trim() === "")
        throw new DomainError("link_invalido", "ref é obrigatório.", 422);
      if (link(code)) throw new DomainError("link_existente", "Já existe link com esse código.", 409);
      db.prepare("INSERT INTO links (code, type, ref, label, created_at) VALUES (?, ?, ?, ?, ?)").run(
        code,
        type,
        ref.trim(),
        typeof label === "string" ? label : null,
        clock.now().toISOString(),
      );
      return link(code) as LinkRow;
    },

    /** Cada passagem pelo redirecionador gera um click_id novo, que vai na URL do app junto com o link. */
    click(code: string): { location: string; clickId: string | null } {
      if (!link(code)) return { location: appOpenUrl, clickId: null };
      const clickId = newId();
      db.prepare("INSERT INTO clicks (click_id, link_code, clicked_at) VALUES (?, ?, ?)").run(
        clickId,
        code,
        clock.now().toISOString(),
      );
      const url = new URL(appOpenUrl);
      url.searchParams.set("link", code);
      url.searchParams.set("click", clickId);
      return { location: url.toString(), clickId };
    },

    /** Chamado pelo app em toda abertura. */
    recordOpen(input: unknown) {
      const deviceId = requireId(text(input, "device_id"), "device_id");
      const linkCode = text(input, "link");
      const clickParam = text(input, "click");
      const now = clock.now().toISOString();

      return transaction(() => {
        let firstOpen = false;
        let current = device(deviceId);
        if (!current) {
          db.prepare("INSERT INTO devices (device_id, first_open_at) VALUES (?, ?)").run(deviceId, now);
          current = { device_id: deviceId, first_open_at: now };
          firstOpen = true;
        }
        const base = {
          device_id: deviceId,
          first_open: firstOpen,
          first_open_at: current.first_open_at,
          window_ends_at: windowEnd(current.first_open_at),
        };
        // Sem o link na URL, o clique basta: o redirecionador gravou os dois juntos.
        const clickRow =
          typeof clickParam === "string" && ID_RE.test(clickParam)
            ? (db.prepare("SELECT click_id, link_code FROM clicks WHERE click_id = ?").get(clickParam) as
                | { click_id: string; link_code: string }
                | undefined)
            : undefined;
        const requested = typeof linkCode === "string" && linkCode !== "" ? linkCode : clickRow?.link_code;
        if (!requested) {
          return clickParam === undefined || clickParam === null || clickParam === ""
            ? { ...base, touch: null }
            : { ...base, touch: null, touch_error: "clique desconhecido e sem link; abertura registrada sem toque" };
        }

        const target = link(requested);
        if (!target) return { ...base, touch: null, touch_error: "link desconhecido; abertura registrada sem toque" };

        // O clique só vale se foi gerado para este link. URL copiada, clique inventado ou de outro link:
        // no máximo um toque por link e aparelho.
        const verified = clickRow !== undefined && clickRow.link_code === target.code;
        const clickId = verified
          ? clickRow.click_id
          : `derived-${createHash("sha1").update(`${deviceId}|${target.code}`).digest("hex").slice(0, 16)}`;
        const clickWarning =
          !verified && typeof clickParam === "string" && clickParam !== ""
            ? "clique desconhecido ou de outro link; contado como um toque por link e aparelho"
            : undefined;
        const findTouch = () =>
          db
            .prepare(
              `SELECT t.*, l.type, l.ref FROM touches t JOIN links l ON l.code = t.link_code
                WHERE t.device_id = ? AND t.click_id = ?`,
            )
            .get(deviceId, clickId) as TouchRow | undefined;
        const duplicate = findTouch() !== undefined;
        if (!duplicate) {
          db.prepare(
            "INSERT INTO touches (device_id, click_id, click_id_source, link_code, recorded_at) VALUES (?, ?, ?, ?, ?)",
          ).run(deviceId, clickId, verified ? "link" : "derived", target.code, now);
        }
        const touch = findTouch() as TouchRow;
        const signedUp = db
          .prepare("SELECT 1 FROM signups WHERE device_id = ? AND signed_up_at < ?")
          .get(deviceId, touch.recorded_at);
        return {
          ...base,
          touch: {
            ...touchView(touch),
            duplicate,
            after_signup: Boolean(signedUp),
          },
          ...(clickWarning ? { click_warning: clickWarning } : {}),
        };
      });
    },

    /** A origem é decidida uma vez; chamar de novo devolve a decisão guardada. */
    signup(input: unknown) {
      const userId = requireId(text(input, "user_id"), "user_id");
      const deviceId = requireId(text(input, "device_id"), "device_id");

      return transaction(() => {
        const existing = db.prepare("SELECT * FROM signups WHERE user_id = ?").get(userId) as SignupRow | undefined;
        if (existing && existing.device_id !== deviceId) {
          throw new DomainError(
            "cadastro_em_outro_aparelho",
            "Esse usuário já tem cadastro registrado em outro aparelho.",
            409,
          );
        }
        if (existing) return { created: false, signup: signupView(existing) };

        const now = clock.now().toISOString();
        const current = device(deviceId);
        const previous = db
          .prepare("SELECT user_id, signed_up_at FROM signups WHERE device_id = ? ORDER BY signed_up_at")
          .all(deviceId) as Array<{ user_id: string; signed_up_at: string }>;
        const touches: Touch[] = touchesOf(deviceId).map((t) => ({
          id: t.id,
          linkCode: t.link_code,
          type: t.type,
          ref: t.ref,
          clickId: t.click_id,
          recordedAt: t.recorded_at,
        }));
        const decision = decideOrigin({
          firstOpenAt: current?.first_open_at ?? null,
          signupAt: now,
          windowDays,
          touches,
          previousSignups: previous.map((p) => ({ userId: p.user_id, at: p.signed_up_at })),
        });

        db.prepare(
          `INSERT INTO signups (user_id, device_id, signed_up_at, origin_type, origin_ref, winning_touch_id, reason, decision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          userId,
          deviceId,
          now,
          decision.origin.type,
          decision.origin.ref,
          decision.origin.touch_id,
          decision.reason,
          JSON.stringify(decision),
        );
        return {
          created: true,
          signup: signupView(db.prepare("SELECT * FROM signups WHERE user_id = ?").get(userId) as SignupRow),
        };
      });
    },

    getSignup(userId: string) {
      const row = db.prepare("SELECT * FROM signups WHERE user_id = ?").get(userId) as SignupRow | undefined;
      if (!row) throw new DomainError("cadastro_nao_encontrado", "Cadastro não encontrado.", 404);
      return signupView(row);
    },

    getDevice(deviceId: string) {
      const row = device(deviceId);
      if (!row) throw new DomainError("aparelho_nao_encontrado", "Aparelho não encontrado.", 404);
      const signups = db
        .prepare("SELECT user_id, signed_up_at, origin_type FROM signups WHERE device_id = ? ORDER BY signed_up_at")
        .all(deviceId);
      return {
        device_id: row.device_id,
        first_open_at: row.first_open_at,
        window_days: windowDays,
        window_ends_at: windowEnd(row.first_open_at),
        touches: touchesOf(deviceId).map(touchView),
        signups,
      };
    },
  };
}
