---
schemaVersion: 1
id: review/types-schema
title: Type safety & schema rigor
---
Is the type system load-bearing or decorative?
  - `any`, `as unknown as T`, `@ts-ignore`,
    `@ts-expect-error`, Rust `unsafe`, Go
    `interface{}`/`reflect` — where, and is each
    justified?
  - Untyped `JSON.parse` results (or equivalents in other
    languages) that flow into typed code without a runtime
    check (zod, serde, pydantic, type guards)
  - Discriminated unions with implicit fall-through cases
  - Schemas where the library's default behavior silently
    drops fields the author probably wanted to validate
  - Schema versioning: how does the code handle a v2
    payload when only v1 is understood? Loud failure or
    silent misinterpret?
  - Optional fields where code assumes presence
