// Decide a origem de um cadastro e explica o veredito de cada toque. Função pura, sem banco.
//
// - Janela: N dias a partir da primeira abertura do app no aparelho, inclusive. Toque depois disso
//   não conta, e cadastro depois disso é orgânico.
// - Toque aberto depois do cadastro não conta.
// - Vence o primeiro toque válido. Um link aberto depois não tira a origem de quem trouxe a pessoa:
//   um convite não é sobrescrito por um anúncio visto na véspera do cadastro.
// - Empate no mesmo instante: indicação > comunidade > campanha; mesmo tipo, ordem de chegada.

export type OriginType = "campaign" | "referral" | "community";

export const ORIGIN_LABELS: Record<OriginType | "organic", string> = {
  campaign: "campanha",
  referral: "indicação",
  community: "comunidade",
  organic: "orgânico",
};

export const TIE_PRIORITY: Record<OriginType, number> = { referral: 1, community: 2, campaign: 3 };

const DAY_MS = 24 * 60 * 60 * 1000;

export type Touch = {
  id: number;
  linkCode: string;
  type: OriginType;
  ref: string;
  clickId: string;
  /** "link": clique gerado pelo redirecionador; "derived": URL copiada ou clique que não vale aqui. */
  clickIdSource: "link" | "derived";
  recordedAt: string;
};

export type TouchVerdict = {
  touch_id: number;
  link: string;
  type: OriginType;
  ref: string;
  click_id: string;
  click_id_source: "link" | "derived";
  recorded_at: string;
  outcome: "won" | "lost" | "ineligible";
  reason: string;
};

export type Decision = {
  origin: { type: OriginType | "organic"; ref: string | null; link: string | null; touch_id: number | null };
  reason: string;
  rule: string;
  window: { days: number; starts_at: string | null; ends_at: string | null; signup_inside: boolean | null };
  touches: TouchVerdict[];
};

function days(n: number): string {
  return n === 1 ? "1 dia" : `${n} dias`;
}

function toIso(value: string): string {
  return new Date(value).toISOString();
}

export function describeRule(windowDays: number): string {
  return `vence o primeiro toque aberto entre a primeira abertura do app e o cadastro, dentro de ${days(windowDays)} a partir da primeira abertura; empate no mesmo instante: indicação > comunidade > campanha`;
}

export function decideOrigin(input: {
  firstOpenAt: string | null;
  signupAt: string;
  windowDays: number;
  touches: Touch[];
  /** Cadastros anteriores no aparelho: os toques até cada um deles já foram usados. */
  previousSignups?: Array<{ userId: string; at: string }>;
}): Decision {
  // Normaliza para ISO UTC antes de comparar strings.
  const signupAt = toIso(input.signupAt);
  const firstOpenAt = input.firstOpenAt ? toIso(input.firstOpenAt) : null;
  const previous = (input.previousSignups ?? [])
    .map((p) => ({ userId: p.userId, at: toIso(p.at) }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const ordered = input.touches
    .map((t) => ({ ...t, recordedAt: toIso(t.recordedAt) }))
    .sort(
      (a, b) => a.recordedAt.localeCompare(b.recordedAt) || TIE_PRIORITY[a.type] - TIE_PRIORITY[b.type] || a.id - b.id,
    );

  const rule = describeRule(input.windowDays);
  const verdict = (t: Touch, outcome: TouchVerdict["outcome"], reason: string): TouchVerdict => ({
    touch_id: t.id,
    link: t.linkCode,
    type: t.type,
    ref: t.ref,
    click_id: t.clickId,
    click_id_source: t.clickIdSource,
    recorded_at: t.recordedAt,
    outcome,
    reason,
  });
  const organic = (reason: string, touches: TouchVerdict[], window: Decision["window"]): Decision => ({
    origin: { type: "organic", ref: null, link: null, touch_id: null },
    reason,
    rule,
    window,
    touches,
  });

  if (!firstOpenAt) {
    return organic(
      "orgânico: o aparelho não tem primeira abertura registrada",
      ordered.map((t) => verdict(t, "ineligible", "aparelho sem primeira abertura registrada")),
      { days: input.windowDays, starts_at: null, ends_at: null, signup_inside: null },
    );
  }

  const windowEnd = new Date(new Date(firstOpenAt).getTime() + input.windowDays * DAY_MS).toISOString();
  const signupInside = signupAt <= windowEnd;
  const window = { days: input.windowDays, starts_at: firstOpenAt, ends_at: windowEnd, signup_inside: signupInside };

  const eligible: Touch[] = [];
  const ineligible = new Map<number, string>();
  for (const t of ordered) {
    const usedBy = previous.find((p) => t.recordedAt <= p.at);
    if (usedBy) {
      ineligible.set(t.id, `já usado pelo cadastro ${usedBy.userId} neste aparelho`);
    } else if (t.recordedAt > signupAt) {
      ineligible.set(t.id, "aberto depois do cadastro");
    } else if (t.recordedAt < firstOpenAt) {
      ineligible.set(t.id, "aberto antes da primeira abertura registrada");
    } else if (t.recordedAt > windowEnd) {
      ineligible.set(t.id, `aberto depois do fim da janela (${windowEnd})`);
    } else if (!signupInside) {
      ineligible.set(t.id, `cadastro feito depois do fim da janela (${windowEnd})`);
    } else {
      eligible.push(t);
    }
  }

  const winner = eligible[0];
  const verdicts = ordered.map((t) => {
    const why = ineligible.get(t.id);
    if (why) return verdict(t, "ineligible", why);
    if (t === winner) return verdict(t, "won", "primeiro toque válido");
    if (winner && t.linkCode === winner.linkCode)
      return verdict(t, "lost", "clique repetido do mesmo link; vale o primeiro");
    if (winner && t.recordedAt === winner.recordedAt) {
      if (t.type === winner.type) return verdict(t, "lost", "mesmo instante e mesmo tipo; vale a ordem de chegada");
      return verdict(
        t,
        "lost",
        `mesmo instante; ${ORIGIN_LABELS[winner.type]} tem prioridade sobre ${ORIGIN_LABELS[t.type]}`,
      );
    }
    return verdict(t, "lost", "um toque válido anterior venceu (vale o primeiro)");
  });

  if (!winner) {
    let reason = "orgânico: nenhum link aberto antes do cadastro";
    if (ordered.length > 0 && !signupInside)
      reason = `orgânico: cadastro feito depois do fim da janela de ${days(input.windowDays)}`;
    else if (ordered.length > 0) reason = "orgânico: nenhum toque válido (veja o motivo de cada um)";
    return organic(reason, verdicts, window);
  }

  return {
    origin: { type: winner.type, ref: winner.ref, link: winner.linkCode, touch_id: winner.id },
    reason: `${ORIGIN_LABELS[winner.type]}: primeiro toque válido, link ${winner.linkCode} aberto em ${winner.recordedAt}`,
    rule,
    window,
    touches: verdicts,
  };
}
