Sealed historical dependency evidence, not the active provider consumer.

The manifest, pnpm10 lock and alpha9 tarball here are exact copies of the
original `examples/apps/email/` files at f97daa49. See
`SEALED-HISTORICAL-CONSUMER.json` for original paths, sizes and SHA256 values.
The parent alpha9 tarball also remains unchanged at its original path.
`../SDK9-PROVENANCE.json` and its corresponding-source archive describe the
historical SDK bytes. No SDK exports, integrity pins or original proof are changed.

The old manifest's application test/build scripts are historical metadata;
this directory intentionally does not fabricate the corresponding old application
source or claim that current example source works with alpha9. The active example
now resolves the real current built workspace SDK. No test loader or polyfill is used.

The scoped .gitattributes disables text normalization only for the three
sealed files, so future Git checkouts preserve their pinned physical bytes.
