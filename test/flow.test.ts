import { describe, expect, it } from "vitest";
import { DAY, setup } from "./helpers.ts";

describe("contrato do link", () => {
  it("o redirecionador gera um clique e leva link e clique na URL do app (sem depender de referrer)", async () => {
    const t = setup();
    await t.seedLinks();
    const first = await t.click("cmp-verao26-ig");
    const second = await t.click("cmp-verao26-ig");
    expect(first.status).toBe(302);
    expect(first.location.origin + first.location.pathname).toBe("https://conty.app/abrir");
    expect(first.link).toBe("cmp-verao26-ig");
    expect(first.click).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.click).not.toBe(first.click);
  });

  it("link desconhecido leva ao app sem atribuição", async () => {
    const t = setup();
    const res = await t.click("nao-existe");
    expect(res.location.toString()).toBe("https://conty.app/abrir");
  });
});

describe("primeira abertura e toques", () => {
  it("grava a primeira abertura do aparelho uma vez só", async () => {
    const t = setup();
    const first = await t.open("dev-aaaa");
    t.advance(DAY);
    const later = await t.open("dev-aaaa");
    expect(first).toMatchObject({
      first_open: true,
      first_open_at: "2026-03-02T15:00:00.000Z",
      window_ends_at: "2026-03-09T15:00:00.000Z",
    });
    expect(later).toMatchObject({ first_open: false, first_open_at: "2026-03-02T15:00:00.000Z" });
  });

  it("o mesmo clique não cria duas origens (recarregar a página, retry do app)", async () => {
    const t = setup();
    await t.seedLinks();
    const { link, click } = await t.click("ind-ana");
    const a = await t.open("dev-aaaa", link, click);
    const b = await t.open("dev-aaaa", link, click);
    expect(a.touch?.duplicate).toBe(false);
    expect(b.touch).toMatchObject({ touch_id: a.touch?.touch_id, duplicate: true });
    const { body } = await t.signup("usr_1", "dev-aaaa");
    expect(body.touches).toHaveLength(1);
  });

  it("URL copiada sem clique: no máximo um toque por link e aparelho", async () => {
    const t = setup();
    await t.seedLinks();
    const a = await t.open("dev-aaaa", "ind-ana");
    t.advance(60_000);
    const b = await t.open("dev-aaaa", "ind-ana");
    expect(a.touch?.click_id_source).toBe("derived");
    expect(b.touch?.duplicate).toBe(true);
  });

  it("clique inventado ou de outro link não vale como clique: conta um toque por link e aparelho", async () => {
    const t = setup();
    await t.seedLinks();
    const campaign = await t.click("cmp-verao26-ig");
    const forged = await t.post("/app/opens", {
      device_id: "dev-aaaa",
      link: "ind-ana",
      click: "clique-inventado-123",
    });
    const crossed = await t.post("/app/opens", { device_id: "dev-aaaa", link: "ind-ana", click: campaign.click });
    const a = (await forged.json()) as { touch: { click_id_source: string; touch_id: number }; click_warning?: string };
    const b = (await crossed.json()) as { touch: { duplicate: boolean; touch_id: number } };
    expect(a.touch.click_id_source).toBe("derived");
    expect(a.click_warning).toBe("clique desconhecido ou de outro link; contado como um toque por link e aparelho");
    expect(b.touch).toMatchObject({ touch_id: a.touch.touch_id, duplicate: true });
  });

  it("só o clique, sem o link na URL, já identifica o link", async () => {
    const t = setup();
    await t.seedLinks();
    const referral = await t.click("ind-ana");
    const res = await t.open("dev-aaaa", null, referral.click);
    expect(res.touch).toMatchObject({ click_id_source: "link" });
    const { body } = await t.signup("usr_1", "dev-aaaa");
    expect(body.origin).toMatchObject({ type: "referral", link: "ind-ana" });
  });

  it("a mesma URL de clique aberta em outro aparelho é outra pessoa: conta para cada aparelho", async () => {
    const t = setup();
    await t.seedLinks();
    const referral = await t.click("ind-ana");
    await t.open("dev-aaaa", referral.link, referral.click);
    await t.open("dev-bbbb", referral.link, referral.click);
    expect((await t.signup("usr_1", "dev-aaaa")).body.origin.type).toBe("referral");
    expect((await t.signup("usr_2", "dev-bbbb")).body.origin.type).toBe("referral");
  });

  it("link desconhecido não impede de registrar a primeira abertura", async () => {
    const t = setup();
    const res = await t.open("dev-aaaa", "nao-existe", "x1234");
    expect(res).toMatchObject({
      first_open: true,
      touch: null,
      touch_error: "link desconhecido; abertura registrada sem toque",
    });
  });
});

describe("cadastro", () => {
  it("campanha: mostra todos os toques considerados e o motivo de cada um", async () => {
    const t = setup();
    await t.seedLinks();
    const campaign = await t.click("cmp-verao26-ig");
    await t.open("dev-aaaa", campaign.link, campaign.click); // primeira abertura veio da campanha
    t.advance(2 * DAY);
    const referral = await t.click("ind-ana");
    await t.open("dev-aaaa", referral.link, referral.click);
    t.advance(DAY);

    const { status, body } = await t.signup("usr_1", "dev-aaaa");
    expect(status).toBe(201);
    expect(body.origin).toMatchObject({ type: "campaign", ref: "cmp_verao26", link: "cmp-verao26-ig" });
    expect(body.window).toEqual({
      days: 7,
      starts_at: "2026-03-02T15:00:00.000Z",
      ends_at: "2026-03-09T15:00:00.000Z",
      signup_inside: true,
    });
    expect(body.touches.map((x) => [x.link, x.outcome, x.reason])).toEqual([
      ["cmp-verao26-ig", "won", "primeiro toque válido"],
      ["ind-ana", "lost", "um toque válido anterior venceu (vale o primeiro)"],
    ]);
  });

  it("empate de horário entre dois links: indicação vence campanha", async () => {
    const t = setup();
    await t.seedLinks();
    await t.open("dev-aaaa");
    t.advance(DAY);
    const campaign = await t.click("cmp-verao26-ig");
    const referral = await t.click("ind-ana");
    await t.open("dev-aaaa", campaign.link, campaign.click); // relógio parado: mesmo instante
    await t.open("dev-aaaa", referral.link, referral.click);
    t.advance(DAY);

    const { body } = await t.signup("usr_1", "dev-aaaa");
    expect(body.origin).toMatchObject({ type: "referral", ref: "crt_ana" });
    expect(body.touches.find((x) => x.link === "cmp-verao26-ig")).toMatchObject({
      outcome: "lost",
      reason: "mesmo instante; indicação tem prioridade sobre campanha",
    });
  });

  it("sem link, fica orgânico com o motivo gravado, não como dado faltando", async () => {
    const t = setup();
    await t.open("dev-aaaa");
    t.advance(DAY);
    const { body } = await t.signup("usr_1", "dev-aaaa");
    expect(body.origin).toEqual({ type: "organic", ref: null, link: null, touch_id: null });
    expect(body.reason).toBe("orgânico: nenhum link aberto antes do cadastro");
    const row = t.db.prepare("SELECT origin_type, reason FROM signups WHERE user_id = 'usr_1'").get();
    expect(row).toEqual({ origin_type: "organic", reason: "orgânico: nenhum link aberto antes do cadastro" });
  });

  it("aparelho que nunca registrou abertura fica orgânico, com motivo", async () => {
    const t = setup();
    const { body } = await t.signup("usr_1", "dev-desconhecido");
    expect(body.reason).toBe("orgânico: o aparelho não tem primeira abertura registrada");
  });

  it("link aberto depois do cadastro não conta e não muda a origem já decidida", async () => {
    const t = setup();
    await t.seedLinks();
    await t.open("dev-aaaa");
    t.advance(DAY);
    const first = await t.signup("usr_1", "dev-aaaa");
    expect(first.body.origin.type).toBe("organic");

    t.advance(1);
    const late = await t.click("ind-ana");
    const opened = await t.open("dev-aaaa", late.link, late.click);
    expect(opened.touch?.after_signup).toBe(true);

    const again = await t.signup("usr_1", "dev-aaaa");
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await (await t.get("/signups/usr_1")).json()).toEqual(first.body);
  });

  it("toque fora da janela não vence: link aberto 8 dias depois da primeira abertura", async () => {
    const t = setup();
    await t.seedLinks();
    await t.open("dev-aaaa"); // primeira abertura orgânica
    t.advance(8 * DAY);
    const campaign = await t.click("cmp-verao26-ig");
    await t.open("dev-aaaa", campaign.link, campaign.click);
    const { body } = await t.signup("usr_1", "dev-aaaa");
    expect(body.origin.type).toBe("organic");
    expect(body.touches[0]).toMatchObject({
      outcome: "ineligible",
      reason: "aberto depois do fim da janela (2026-03-09T15:00:00.000Z)",
    });
  });

  it("cadastro depois do fim da janela é orgânico, mesmo com link aberto dentro dela", async () => {
    const t = setup();
    await t.seedLinks();
    const referral = await t.click("ind-ana");
    await t.open("dev-aaaa", referral.link, referral.click);
    t.advance(7 * DAY + 1);
    const { body } = await t.signup("usr_1", "dev-aaaa");
    expect(body.origin.type).toBe("organic");
    expect(body.reason).toBe("orgânico: cadastro feito depois do fim da janela de 7 dias");
  });

  it("o mesmo usuário não troca de aparelho num segundo envio do cadastro", async () => {
    const t = setup();
    await t.open("dev-aaaa");
    await t.open("dev-bbbb");
    await t.signup("usr_1", "dev-aaaa");
    const res = await t.post("/signups", { user_id: "usr_1", device_id: "dev-bbbb" });
    expect(res.status).toBe(409);
  });

  it("recusa janela inválida ao subir a API", () => {
    expect(() => setup({ windowDays: Number("sete") })).toThrow(/janela de validade inválida/);
    expect(() => setup({ windowDays: 0 })).toThrow(/janela de validade inválida/);
  });

  it("a janela é configurável", async () => {
    const t = setup({ windowDays: 30 });
    await t.seedLinks();
    const referral = await t.click("ind-ana");
    await t.open("dev-aaaa", referral.link, referral.click);
    t.advance(20 * DAY);
    const { body } = await t.signup("usr_1", "dev-aaaa");
    expect(body.origin.type).toBe("referral");
    expect(body.window.days).toBe(30);
  });
});
