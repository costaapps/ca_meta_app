# Contract format and validator references

- OpenAPI uses version 3.1.0. The [official OAS 3.1.0 specification](https://spec.openapis.org/oas/v3.1.0) defines the OpenAPI document structure and aligns Schema Objects with JSON Schema Draft 2020-12, extended by the OpenAPI base dialect.
- The standalone inbox/outbox event schemas declare [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12/schema) explicitly. The local harness validates their examples with Ajv's 2020 implementation.
- Each event type is constrained to its matching safe metadata/data kind. Consumers may dispatch on `eventType` without accepting a contradictory payload kind.
- Redocly CLI validates the OAS document; `openapi-typescript` generates public types from the same YAML. The internal operation is intentionally filtered before generating the browser client.
- [`@pb33f/openapi-changes` v0.2.13](https://github.com/pb33f/openapi-changes) compares OAS 3.1 contracts in local validation and the narrowly scoped PR workflow. The tool version is pinned in `tools/m1-07/package-lock.json`; a local path-removal fixture verifies its breaking-change detection.

These format references validate syntax and type representation only. They do not confirm provider grants, Suite4 identity configuration, deployed routes, external exactly-once behavior, or production semantics.
