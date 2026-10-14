# README engineering brief

## Reusable prompt

Act as a principal engineer and technical editor reviewing Advisor Brief, a public software engineering and product design exercise. Inspect the repository before writing. Follow its contributor instructions and preserve published Git history.

Rewrite the README so a hiring manager can understand the work quickly and an experienced engineer can reproduce and challenge it. Lead with the user problem and the exercise's scope. Explain the architecture, request lifecycle, evidence acquisition, financial derivation, structured generation, independent review, deterministic checks, fallback, retrieval, memory, public API, configuration, testing, security boundaries, and production work still required.

Ground each consequential claim in the implementation and link to the relevant source. Separate configured capability, default behavior, external dependencies, and future work. Treat code comments and the existing README as claims to check, not proof. Explain why a choice was made and the tradeoff it creates. Do not invent deployments, metrics, credentials, clients, benchmark results, or guarantees. Use clear, specific language; do not claim that the writing or software was created without AI assistance or promise detector evasion.

Create precise, editable SVG illustrations for light mode: a restrained title graphic, system architecture, generated-claim review, and follow-up retrieval. Use opaque white backgrounds, consistent type, accessible descriptions, generous spacing, and meaningful labels. Keep source and generation scripts together. Avoid decorative charts that resemble measured results.

Review all prose against the code. Check relative links, heading anchors, SVG structure, text fit, and rendering at desktop and mobile widths. Run relevant existing checks and report their actual results. Publish only the reviewed documentation and assets through an additive GitHub commit and pull request. Do not change application behavior to make the documentation's claims true.

## Scope of this revision

Implementation reviewed at `c070b7ea9f250bd3d07bc8b5f839f35fe6159d22`. This revision changes documentation and its illustrations. Runtime configuration, model settings, APIs, database schema, and application behavior are unchanged.

Rebuild illustrations with `python docs/readme/render_diagrams.py`. The files use the Python standard library and embed their own light backgrounds, titles, and descriptions.
