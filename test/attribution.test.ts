import { describe, expect, it } from "vitest";
import { decideOrigin, type Touch } from "../src/attribution.ts";

const FIRST_OPEN = "2026-03-02T15:00:00.000Z"; // janela de 7 dias termina em 2026-03-09T15:00:00.000Z

let nextId = 1;
function touch(linkCode: string, type: Touch["type"], recordedAt: string): Touch {
  return { id: nextId++, linkCode, type, ref: `${type}-ref`, clickId: `clk-${nextId}`, recordedAt };
}

describe("qual toque vence", () => {
  it("com dois links diferentes antes do cadastro, vence o primeiro", () => {
    const campaign = touch("cmp-verao26-ig", "campaign", "2026-03-02T15:00:00.000Z");
    const referral = touch("ind-ana", "referral", "2026-03-04T10:00:00.000Z");
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signupAt: "2026-03-05T12:00:00.000Z",
      windowDays: 7,
      touches: [referral, campaign],
    });
    expect(decision.origin).toEqual({
      type: "campaign",
      ref: "campaign-ref",
      link: "cmp-verao26-ig",
      touch_id: campaign.id,
    });
    expect(decision.touches.map((t) => [t.link, t.outcome, t.reason])).toEqual([
      ["cmp-verao26-ig", "won", "primeiro toque válido"],
      ["ind-ana", "lost", "um toque válido anterior venceu (vale o primeiro)"],
    ]);
  });

  it("empate de horário: indicação vence campanha, e comunidade vence campanha", () => {
    const at = "2026-03-03T09:00:00.000Z";
    const tie = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signupAt: "2026-03-03T10:00:00.000Z",
      windowDays: 7,
      touches: [touch("cmp-verao26-ig", "campaign", at), touch("ind-ana", "referral", at)],
    });
    expect(tie.origin.type).toBe("referral");
    expect(tie.touches[1]).toMatchObject({
      link: "cmp-verao26-ig",
      outcome: "lost",
      reason: "mesmo instante; indicação tem prioridade sobre campanha",
    });

    const communityTie = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signupAt: "2026-03-03T10:00:00.000Z",
      windowDays: 7,
      touches: [touch("cmp-verao26-ig", "campaign", at), touch("com-ugc-sp", "community", at)],
    });
    expect(communityTie.origin.type).toBe("community");
  });

  it("dois links do mesmo tipo no mesmo instante: vale a ordem de chegada", () => {
    const at = "2026-03-03T09:00:00.000Z";
    const first = touch("cmp-verao26-ig", "campaign", at);
    const second = touch("cmp-verao26-tiktok", "campaign", at);
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signupAt: "2026-03-03T10:00:00.000Z",
      windowDays: 7,
      touches: [second, first],
    });
    expect(decision.origin.link).toBe("cmp-verao26-ig");
    expect(decision.touches[1]).toMatchObject({
      link: "cmp-verao26-tiktok",
      reason: "mesmo instante e mesmo tipo; vale a ordem de chegada",
    });
  });

  it("clique repetido do mesmo link não muda nada: vale o primeiro", () => {
    const first = touch("ind-ana", "referral", "2026-03-02T15:00:00.000Z");
    const again = touch("ind-ana", "referral", "2026-03-03T15:00:00.000Z");
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signupAt: "2026-03-04T00:00:00.000Z",
      windowDays: 7,
      touches: [first, again],
    });
    expect(decision.origin.touch_id).toBe(first.id);
    expect(decision.touches[1]).toMatchObject({
      outcome: "lost",
      reason: "clique repetido do mesmo link; vale o primeiro",
    });
  });
});

describe("o que não vale", () => {
  it("toque aberto depois do cadastro não vence", () => {
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signupAt: "2026-03-03T00:00:00.000Z",
      windowDays: 7,
      touches: [touch("ind-ana", "referral", "2026-03-03T00:00:00.001Z")],
    });
    expect(decision.origin.type).toBe("organic");
    expect(decision.touches[0]).toMatchObject({ outcome: "ineligible", reason: "aberto depois do cadastro" });
  });

  it("toque aberto depois do fim da janela não vence", () => {
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signupAt: "2026-03-09T15:00:00.000Z",
      windowDays: 7,
      touches: [touch("cmp-verao26-ig", "campaign", "2026-03-09T15:00:00.001Z")],
    });
    expect(decision.origin.type).toBe("organic");
  });

  it("a janela vale até o último instante, inclusive; 1 ms depois o cadastro já é orgânico", () => {
    const touches = [touch("cmp-verao26-ig", "campaign", FIRST_OPEN)];
    const atEnd = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signupAt: "2026-03-09T15:00:00.000Z",
      windowDays: 7,
      touches,
    });
    expect(atEnd.origin.type).toBe("campaign");
    expect(atEnd.window).toEqual({
      days: 7,
      starts_at: FIRST_OPEN,
      ends_at: "2026-03-09T15:00:00.000Z",
      signup_inside: true,
    });

    const after = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signupAt: "2026-03-09T15:00:00.001Z",
      windowDays: 7,
      touches,
    });
    expect(after.origin.type).toBe("organic");
    expect(after.reason).toBe("orgânico: cadastro feito depois do fim da janela de 7 dias");
    expect(after.touches[0]?.reason).toBe("cadastro feito depois do fim da janela (2026-03-09T15:00:00.000Z)");
  });

  it("toques já usados por cadastros anteriores no mesmo aparelho não contam de novo, e o motivo diz qual cadastro usou", () => {
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signupAt: "2026-03-05T00:00:00.000Z",
      windowDays: 7,
      touches: [
        touch("ind-ana", "referral", "2026-03-02T15:00:00.000Z"),
        touch("com-ugc-sp", "community", "2026-03-03T12:00:00.000Z"),
      ],
      previousSignups: [
        { userId: "usr_2", at: "2026-03-04T00:00:00.000Z" },
        { userId: "usr_1", at: "2026-03-03T00:00:00.000Z" },
      ],
    });
    expect(decision.origin.type).toBe("organic");
    expect(decision.touches.map((t) => t.reason)).toEqual([
      "já usado pelo cadastro usr_1 neste aparelho",
      "já usado pelo cadastro usr_2 neste aparelho",
    ]);
  });

  it("toque anterior à primeira abertura registrada não vence", () => {
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signupAt: "2026-03-03T00:00:00.000Z",
      windowDays: 7,
      touches: [touch("ind-ana", "referral", "2026-03-02T14:59:59.999Z")],
    });
    expect(decision.origin.type).toBe("organic");
    expect(decision.touches[0]?.reason).toBe("aberto antes da primeira abertura registrada");
  });

  it("compara horários em UTC mesmo quando chegam com offset", () => {
    const touches = [touch("cmp-verao26-ig", "campaign", FIRST_OPEN)];
    // 12:00:00.001-03:00 = 15:00:00.001Z: 1 ms depois do fim da janela.
    const late = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signupAt: "2026-03-09T12:00:00.001-03:00",
      windowDays: 7,
      touches,
    });
    expect(late.origin.type).toBe("organic");
    const atEnd = decideOrigin({ firstOpenAt: FIRST_OPEN, signupAt: "2026-03-09T15:00:00Z", windowDays: 7, touches });
    expect(atEnd.origin.type).toBe("campaign");
  });
});

describe("orgânico com motivo", () => {
  it("sem nenhum link aberto", () => {
    const decision = decideOrigin({
      firstOpenAt: FIRST_OPEN,
      signupAt: "2026-03-03T00:00:00.000Z",
      windowDays: 7,
      touches: [],
    });
    expect(decision).toMatchObject({
      origin: { type: "organic", ref: null, link: null, touch_id: null },
      reason: "orgânico: nenhum link aberto antes do cadastro",
    });
  });

  it("sem primeira abertura registrada", () => {
    const decision = decideOrigin({
      firstOpenAt: null,
      signupAt: "2026-03-03T00:00:00.000Z",
      windowDays: 7,
      touches: [],
    });
    expect(decision.reason).toBe("orgânico: o aparelho não tem primeira abertura registrada");
  });
});
