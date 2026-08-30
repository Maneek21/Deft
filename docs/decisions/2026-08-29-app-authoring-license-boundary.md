# ADR: Declarative App Authoring License Boundary

- Status: Accepted for the declarative App v0 alpha
- Date: 2026-08-29
- Revisit: before distributing a linked browser SDK, runtime SDK, proprietary official Add-on, or license exception

## Context

Deft is AGPL-3.0-only and accepts contributions under AGPL-3.0-only without a contributor license agreement or copyright assignment. The product will remain open and self-hostable while a future business may sell hosted Deft and managed Add-ons.

The GNU AGPL requires a modified network-interactive version to offer its users the Corresponding Source. Whether an App, plug-in, or runtime is a separate work depends on the technical and legal relationship, not its marketing name or container boundary. This ADR records a conservative alpha policy; it is not legal advice.

## Decision

The initial declarative App kit and CLI distributed from this repository remain AGPL-3.0-only, consistent with the rest of the repository.

Declarative App output is data, not linked executable code. The kit must generate manifests, schemas, briefs, and instructions from scratch and must not copy Deft implementation code into an App. Each App package declares its own SPDX license metadata, and its author is responsible for choosing and complying with that license and all included artifacts.

Using the CLI to create declarative output does not grant the App authority and does not make Deft promise that every declared license is compatible with every future App plane. Installation review displays provenance and license metadata but is not a legal-compliance engine.

Self-hosted users can author, inspect, build, and locally install declarative Apps without a hosted account, registry, entitlement, payment, or call home. Community Apps and official Apps use the same package and security contracts.

A paid Add-on may package an open declarative App with managed hosting, connectors, runtime service, operations, support, usage allowances, or an SLA. Commercial entitlement remains outside the App manifest and workspace authorization model.

No proprietary compatibility claim is made for a future browser SDK, runtime SDK, in-process extension, bundled provider, or intimately coupled external runtime. Those artifacts require a separate architecture and legal review before distribution. Deft does not assume it can relicense third-party contributions outside AGPL without the necessary rights.

Hosted Deft must retain a prominent source offer for the exact modified version served to users, using the existing source-code URL mechanism or an equivalent compliant implementation.

## Why this is the alpha policy

It allows work on a non-executable App package without changing the repository's license, claiming a legal plug-in exception, or blocking self-hosting. It preserves the option to design a narrower permissive protocol/SDK artifact later if the copyright and contributor boundaries support it.

## Rejected alternatives

- Declaring all third-party Apps automatically AGPL is rejected; Deft cannot settle derivative-work questions through manifest metadata.
- Declaring proprietary Apps automatically safe because they use HTTP, containers, or iframes is rejected; communication mechanism and semantic coupling both matter.
- Embedding payment or entitlement fields in `deft.app.json` is rejected because commercial availability and workspace authority are separate contracts.

## Acceptance evidence

Before the declarative kit is published, package metadata, generated files, documentation, and tests must show its AGPL license, avoid copied Deft source in generated Apps, require explicit App license metadata, and function with hosted Deft services blocked.

Before any linked SDK or proprietary official Add-on is distributed, obtain specialist legal review and either confirm the existing license boundary or record a new decision with the necessary contributor permissions.
