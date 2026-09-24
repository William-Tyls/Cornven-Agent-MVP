# Public snapshot scope

This repository is a clean snapshot of the Plan B application, not a Git-history mirror.
Application code, schemas, migrations, synthetic transaction fixtures and applicable unit tests are retained.

Customer SOP Markdown, structure metadata, resource manifests, private retrieval/answer evaluation fixtures, original HTML, PDFs, images, paid-response recordings and the previous Git history are not published. Customer-dependent tests and browser scripts are retained only in the private local copy. The private OpenSpec archive and internal team documents are also excluded because they contain source excerpts, customer links and private implementation records. The original team CI and CODEOWNERS are not transferred to this personal repository.

The public knowledge base is newly authored synthetic demo material. It does not represent customer policy. The full RAG implementation remains in the application, but customer contract links and private-corpus evaluation cannot be reproduced from this public snapshot.

`pnpm quality` validates this public edition: format, lint, API contracts, Prisma schema, types, build, included tests and the synthetic RAG smoke check. Private corpus audits are not included and are not reported as passing. `quality:private` preserves the old command as a reference only; it requires restoring the private scripts, fixtures and authorized source material first.

The selected Chatbot default is k=8. The private RAG change was archived with 66/73 tasks complete; seven human quality/release tasks remain incomplete. Public publication does not change those results or mean production readiness.

Third-party contributions and rights remain with their respective owners. Complete development history remains in the private local repository. No claim of sole authorship is made by publishing this snapshot.
