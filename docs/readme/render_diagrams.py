"""Rebuild the README's light-mode SVGs with Python's standard library.

Run from any directory: python docs/readme/render_diagrams.py
SVGs contain selectable text, accessible titles, and no external assets.
"""
from html import escape
from pathlib import Path

OUT = Path(__file__).resolve().parent
INK, MUTED, TEAL, LINE = '#172B45', '#52657A', '#086C64', '#D6E1E7'
PALE, BLUE, AMBER = '#EAF6F2', '#EFF3FC', '#FFF5E5'


class Diagram:
    def __init__(self, height, title, description):
        self.parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="{height}" viewBox="0 0 1120 {height}" role="img" aria-labelledby="title description">',
                      f'<title id="title">{escape(title)}</title><desc id="description">{escape(description)}</desc>',
                      '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto-start-reverse"><path d="M1 1 L7 4 L1 7" fill="none" stroke="#73889C" stroke-width="1.5"/></marker></defs>',
                      f'<rect x="1" y="1" width="1118" height="{height-2}" rx="20" fill="#FFFFFF" stroke="{LINE}"/>',
                      '<g font-family="DejaVu Sans, Arial, sans-serif">']

    def rect(self, x, y, w, h, fill='#FFFFFF', stroke=LINE, radius=12):
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>')

    def text(self, x, y, content, size=20, color=INK, weight=400):
        self.parts.append(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-weight="{weight}">{escape(content)}</text>')

    def lines(self, x, y, lines, size=19, gap=29, color=MUTED):
        for i, content in enumerate(lines):
            self.text(x, y + i * gap, content, size, color)

    def path(self, d, dashed=False):
        self.parts.append(f'<path d="{d}" fill="none" stroke="#73889C" stroke-width="2" marker-end="url(#arrow)"'+(' stroke-dasharray="6 5"' if dashed else '')+'/>')

    def header(self, number, title, subtitle):
        self.text(48, 45, f'ADVISOR BRIEF  /  {number}', 14, TEAL, 700)
        self.text(48, 86, title, 31, INK, 700)
        self.text(48, 116, subtitle, 17, MUTED)

    def card(self, x, y, w, h, title, lines, fill='#FFFFFF'):
        self.rect(x, y, w, h, fill)
        self.text(x+23, y+37, title, 22, INK, 700)
        self.lines(x+23, y+70, lines)

    def save(self, filename):
        (OUT / filename).write_text('\n'.join(self.parts + ['</g></svg>'])+'\n')


d = Diagram(458, 'Advisor Brief', 'Company research with an evidence trail. A public software engineering and product design exercise by Estimé Aristomene, Jr.')
d.rect(24, 24, 1072, 410, '#F7FAFC', '#F7FAFC', 14)
d.text(54, 71, 'AIQORX  /  PUBLIC ENGINEERING EXERCISE', 15, TEAL, 700)
d.text(52, 145, 'Advisor Brief', 57, INK, 700)
d.lines(55, 194, ['Company research', 'with an evidence trail.'], 30, 41, INK)
d.lines(55, 285, ['Public filings. Structured research.', 'Claims you can inspect.'], 20, 31)
d.text(55, 386, 'Estimé Aristomene, Jr.  ·  Principal Engineer', 17, MUTED)
d.rect(704, 65, 342, 330, '#FFFFFF')
d.text(730, 107, 'FROM SOURCE TO STATEMENT', 13, TEAL, 700)
for y, label, detail, fill in [(127, '01  Source', 'Filing · section · accession', BLUE), (214, '02  Claim', 'Structured, cited narrative', '#F5F7FA'), (301, '03  Check', 'Review · quote · figures', PALE)]:
    d.rect(726, y, 298, 72, fill, fill, 8)
    d.text(743, y+28, label, 21, INK, 700)
    d.text(743, y+53, detail, 16, MUTED)
    if y < 301:
        d.path(f'M875 {y+72} V{y+85}')
d.save('hero.svg')

d = Diagram(1090, 'System architecture', 'Browser presentation is separated from server orchestration, source adapters, model transport, and optional persistence.')
d.header('01', 'A research workflow with clear boundaries', 'Presentation in the browser. Evidence, inference, and privileged access on the server.')
d.card(48, 151, 1024, 108, 'Advisor workspace', ['React · company search · financials · progressive blocks · evidence inspection · Q&A'], BLUE)
d.path('M560 259 V302')
d.text(579, 287, 'SSE and JSON', 16, MUTED)
d.rect(48, 303, 1024, 452, '#F8FAFC')
d.text(72, 341, 'SERVER BOUNDARY', 14, TEAL, 700)
d.card(72, 365, 976, 92, 'TanStack Start routes · /api/public', ['/advisor-brief     /advisor-ask     /advisor-memory'])
for cx in [228, 560, 892]:
    d.path(f'M{cx} 457 V498')
d.card(72, 499, 312, 201, 'Evidence', ['Resolve the company', 'Load and parse filings', 'Derive financial periods', 'Preserve source metadata'])
d.card(404, 499, 312, 201, 'Generation & review', ['Write structured blocks', 'Review cited claims', 'Check quotes and figures', 'Construct fallback output'], PALE)
d.card(736, 499, 312, 201, 'Retrieval & memory', ['Rank filing passages', 'Replay eligible briefs', 'Store conversation turns', 'Keep local indexes'])
d.text(73, 731, 'Runtime bindings hold credentials. The browser receives results and evidence metadata.', 17, MUTED)
for cx in [167, 429, 691, 953]:
    d.path(f'M{cx} 755 V826')
d.card(48, 827, 238, 158, 'SEC EDGAR', ['Submissions', 'Filing HTML', 'XBRL facts'], BLUE)
d.card(310, 827, 238, 158, 'Market data', ['Yahoo chart API', 'Prototype context', 'Separate source'])
d.card(572, 827, 238, 158, 'Google Gemini', ['Writer and reviewer', 'Follow-up answers', 'Optional vectors'], PALE)
d.card(834, 827, 238, 158, 'Supabase', ['Optional persistence', 'Briefs and turns', 'Server-role access'])
d.text(48, 1037, 'Retrieval indexes stay in process, including when durable memory is enabled.', 18, MUTED)
d.save('architecture.svg')

d = Diagram(1060, 'Generated claim review', 'The generated-claim path checks citations, obtains a separate model review, and reconciles quotes and figures before applying a display policy. Source-derived output has different semantics.')
d.header('02', 'A citation is the beginning of the check', 'Review model output against retained evidence, then make the verdict visible.')
d.card(64, 153, 992, 100, 'Generated claim + section IDs', ['Remove unknown citation IDs. Preserve the claim for explicit review.'], BLUE)
d.path('M560 253 V275 H301 V296')
d.card(64, 297, 474, 123, 'Claim-specific evidence', ['Select relevant windows from cited text.', 'Retain section metadata and source links.'])
d.card(558, 297, 498, 123, 'Separate Gemini review', ['Return verdict, evidence quote, and reason.', 'Separate invocation; same default model.'], PALE)
d.path('M538 354 H557')
d.path('M807 420 V450 H560 V476')
d.card(64, 477, 992, 130, 'Deterministic reconciliation', ['Quote: normalized containment and tolerant token matching.', 'Figures: scale-aware numeric matching with rounding tolerance.'])
d.path('M560 607 V650')
d.rect(383, 651, 354, 72, PALE)
d.text(421, 696, 'Apply verdict + policy', 23, INK, 700)
d.path('M450 723 V747 H223 V778')
d.path('M560 723 V778')
d.path('M670 723 V747 H897 V778')
d.card(64, 779, 316, 129, 'Display', ['Supported by this pipeline', 'Evidence remains inspectable'], PALE)
d.card(402, 779, 316, 129, 'Flag', ['Partial or uncited', 'Visible review state'], AMBER)
d.card(740, 779, 316, 129, 'Hold by default', ['Unsupported or unverified', 'Inspect in the review area'], '#FFF0EE')
d.rect(64, 947, 992, 73, '#F7F9FB')
d.lines(86, 977, ['Source-derived fallback is a separate construction path, not this complete review.', 'A supported verdict is not an accuracy guarantee. Text may stream before review.'], 17, 25)
d.save('claim-review.svg')

d = Diagram(1140, 'Follow-up retrieval', 'Retained sections are chunked for BM25 and optional vector scoring. Weighted fusion selects a bounded set of passages for a factual question, followed by answer checks.')
d.header('03', 'Small evidence packets for specific questions', 'Lexical retrieval is the default. Semantic retrieval is an explicit option.')
d.card(64, 151, 992, 99, 'Retained filing sections', ['Accession-keyed evidence; original form, item, URL, and fetch metadata.'], BLUE)
d.path('M560 250 V289')
d.card(64, 290, 992, 99, 'Overlapping passages', ['900-character target · 150-character overlap · sentence-boundary preference'])
d.path('M365 389 V420 H301 V450')
d.path('M755 389 V420 H807 V450', True)
d.card(64, 451, 474, 142, 'BM25 · always available', ['Token frequencies and document lengths', 'k1 = 1.4 · b = 0.75', 'Normalize by the top lexical score'])
d.card(558, 451, 498, 142, 'Gemini vectors · optional', ['Embedding batches of 32 passages', 'Normalized vectors and query embedding', 'Cosine similarity; lexical fallback'], PALE)
d.path('M301 593 V622 H480 V650')
d.path('M807 593 V622 H640 V650', True)
d.card(64, 651, 992, 106, 'Question scoring and weighted fusion', ['Hybrid: 0.45 × lexical + 0.55 × max(0, cosine). Otherwise: lexical score alone.'])
d.path('M560 757 V797')
d.card(64, 798, 992, 105, 'Select the evidence packet', ['Up to 6 passages · at most 2 per section · no minimum relevance threshold'])
d.path('M560 903 V942')
d.card(64, 943, 992, 126, 'Answer, then check', ['Gemini receives selected passages and up to 6 prior conversation turns.', 'Allow-list citations; check figures, any returned quote, and screened language.'], PALE)
d.text(64, 1110, 'Q&A does not run the briefing’s separate model review. Answerability still needs evaluation.', 17, MUTED)
d.save('retrieval.svg')
