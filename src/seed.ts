import type { DatabaseSync } from "node:sqlite";

// Links de exemplo para rodar localmente.
export function seedLinks(db: DatabaseSync): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number };
  if (row.n > 0) return;
  const insert = db.prepare("INSERT INTO links (code, type, ref, label, created_at) VALUES (?, ?, ?, ?, ?)");
  const now = new Date().toISOString();
  insert.run("cmp-verao26-ig", "campaign", "cmp_verao26", "Campanha Verão 26 (Instagram)", now);
  insert.run("ind-ana", "referral", "crt_ana", "Convite da criadora Ana", now);
  insert.run("com-ugc-sp", "community", "grp_ugc_sp", "Comunidade UGC São Paulo (WhatsApp)", now);
}
