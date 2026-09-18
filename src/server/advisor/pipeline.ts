// Shared data steps used by the briefing and the follow up question routes.
import { resolve, submissions, selectFilings, document_, companyFacts, getQuote, sections10k, sections10q, section8k, type Company, type Filing, type Section } from "./edgar";
import { briefingKey } from "./memory";

export type Loaded = {
  company: Company;
  sel: ReturnType<typeof selectFilings>;
  quote: any;
  factsRes: any;
  accessions: string[];
  key: string;
};

export async function loadCompany(q: string, withQuote = true): Promise<Loaded> {
  const company = await resolve(q);
  const [sub, quote, factsRes] = await Promise.all([
    submissions(company.cik),
    withQuote ? getQuote(company.ticker) : Promise.resolve(null),
    companyFacts(company.cik).catch((e) => ({ error: String(e) })),
  ]);
  const sel = selectFilings(sub, company.cik);
  Object.assign(company, Object.fromEntries(Object.entries(sel.company).filter(([k]) => k !== "name")));
  const accessions = [sel["10-K"], sel["10-Q"], ...sel["8-K"]].filter((f): f is Filing => !!f).map((f) => f.accession);
  return { company, sel, quote, factsRes, accessions, key: briefingKey(company.ticker, accessions) };
}

export async function loadSections(sel: ReturnType<typeof selectFilings>): Promise<Section[]> {
  const jobs: Array<[string, Filing]> = [];
  if (sel["10-K"]) jobs.push(["10-K", sel["10-K"]]);
  if (sel["10-Q"]) jobs.push(["10-Q", sel["10-Q"]]);
  for (const f of sel["8-K"]) jobs.push(["8-K", f]);
  const htmls = await Promise.allSettled(jobs.map(([, f]) => document_(f)));
  const sections: Section[] = [];
  htmls.forEach((h, i) => {
    if (h.status !== "fulfilled") return;
    const [form, f] = jobs[i]!;
    try {
      if (form === "10-K") sections.push(...sections10k(h.value, f));
      else if (form === "10-Q") sections.push(...sections10q(h.value, f));
      else sections.push(section8k(h.value, f));
    } catch {
      /* skip a filing that will not parse */
    }
  });
  return sections;
}
