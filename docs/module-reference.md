# Module manifest reference (schema version 1)

This reference describes `deft.module.json` for Module schema version `1`. It is derived from the Zod contract in `packages/shared/src/modules.ts`, which is the authority for what `pnpm module:check` accepts. Unknown keys are errors at every level, and cross-field rules are enforced by the parser rather than by JSON Schema. `pnpm module:check` parses version `1` only; the parser also defines a version `2` with `resource_ref` fields, but this command does not accept that version.

For the guided build, use [Build your first Module](tutorials/first-module.md). For the packaging choice, see [Modules and Apps](modules-and-apps.md). Complete manifests live in [the vendor-pilot example](examples/vendor-pilot/deft.module.json) and the bundled Contacts module (`modules/bundled/contacts/deft.module.json`).

## Top-level keys

| Key | Type | Required | Constraints | Meaning |
|---|---|---|---|---|
| `schema_version` | string | yes | Exactly `"1"`. | Contract version. |
| `id` | string | yes | 3–128 characters; lowercase reverse-DNS with at least one dot, for example `community.example.invoice-tracker`. | Stable installation identity. Changing it creates a different Module. |
| `slug` | string | yes | 1–48 characters; lowercase kebab-case. | User-facing route token. Changing it creates a different installation identity. |
| `version` | string | yes | Strict semantic version, at most 64 characters: `MAJOR.MINOR.PATCH`, optionally with `-prerelease` and `+build`. No leading `v`. | Manifest version. Installed versions are immutable. |
| `name` | string | yes | 1–80 characters of single-line plain text. | Display name. |
| `description` | string | no | 1–500 characters of single-line plain text. | Display description. |
| `icon` | string | no | 1–48 characters; lowercase kebab-case token such as `briefcase`. Not a URL or markup. | Navigation icon token. |
| `collections` | array | yes | 1–8 collections. | The records the Module exposes. |
| `navigation` | object | no | `{ "default_collection": key, "default_view"?: key }`. | Initial collection and view. |

Plain text is trimmed. It cannot contain `<` or `>`, control characters, zero-width or bidi controls, or line breaks. Errors use the form `Display name must be single-line plain text without markup, control characters, or bidi controls`.

The renderer currently maps `book`, `briefcase`, `calendar`, `contacts`, `contact`, `database`, `folder`, `package`, `table`, `users`, and `boxes` to icons. Any other valid token renders as `boxes` rather than failing validation. <!-- apps/web/src/components/modules/module-primitives.tsx:20-36 -->

## Collections

| Key | Type | Required | Constraints | Meaning |
|---|---|---|---|---|
| `key` | string | yes | 1–48 characters; lowercase snake_case; unique within the manifest. | Stable collection identifier. |
| `name` | string | yes | 1–80 characters of plain text. | Plural display name. |
| `singular_name` | string | no | 1–80 characters of plain text. | Singular display name. |
| `description` | string | no | 1–500 characters of plain text. | Collection description. |
| `fields` | array | yes | 1–64 fields. | Record schema. |
| `search` | object | no | See [Search](#search). | Opt-in universal-search projection. A collection without it is not indexed. |
| `views` | array | no | At most 8 views. | Presentation hints. |
| `latest_related` | array | no | At most 4 summaries. | Read-only "latest related record" summaries. |

`latest_related` entries contain `key` (snake_case, unique per collection), `label`, optional `description`, `source_collection`, `relation_field`, `date_field`, and optional `where` (at most 4 entries, each `{ "field": key, "values": [1–100 select option values] }`). The source collection must declare a `relation` field that targets this collection, `date_field` must be a `date` or `datetime`, and each `where.field` must be a `single_select` with declared values. <!-- packages/shared/src/modules.ts:475-486,704-724 -->

## Fields

### Common field keys

| Key | Type | Required | Constraints |
|---|---|---|---|
| `key` | string | yes | 1–48 characters; lowercase snake_case; unique within the collection; not a reserved key. |
| `label` | string | yes | 1–80 characters of plain text. |
| `description` | string | no | 1–500 characters of plain text. |
| `required` | boolean | no | Defaults to `false`. `relation` fields must keep it `false`. |
| `type` | string | yes | One of the types below. |

Reserved field keys: `__proto__`, `constructor`, `prototype`, `id`, `org_id`, `module_id`, `installation_id`, `collection_key`, `revision`, `created_at`, `updated_at`, `archived_at`. The error is `Field key is reserved by Deft`. <!-- packages/shared/src/modules.ts:57-70,104-109 -->

### Field types

| `type` | Extra keys | Value and default rules | Searchable | Quick-filter operators |
|---|---|---|---|---|
| `text` | `default` (string) | Up to 10,000 characters. | yes | `eq`, `neq`, `contains`, `in`, `is_empty` |
| `long_text` | `default` (string) | Up to 100,000 characters. | yes | `eq`, `neq`, `contains`, `in`, `is_empty` |
| `email` | `default` (string) | Must match a basic address shape, up to 320 characters. | yes | `eq`, `neq`, `contains`, `in`, `is_empty` |
| `url` | `default` (string) | Absolute HTTP or HTTPS URL, up to 2,048 characters. | yes | `eq`, `neq`, `contains`, `in`, `is_empty` |
| `date` | `default` (string) | Real calendar date in `YYYY-MM-DD`. | yes | `eq`, `neq`, `in`, `is_empty`, `date_relative`, `gt`, `gte`, `lt`, `lte` |
| `datetime` | `default` (string) | ISO 8601 with an explicit timezone, for example `2026-10-19T09:00:00Z`. | yes | `eq`, `neq`, `in`, `is_empty`, `gt`, `gte`, `lt`, `lte` |
| `number` | `default` (finite number) | Must be finite. | yes | `eq`, `neq`, `is_empty`, `gt`, `gte`, `lt`, `lte` |
| `boolean` | `default` (boolean) | `true` or `false`. | yes | `eq`, `neq`, `is_empty` |
| `single_select` | `options` (1–50), `default` (option value) | Options are `{ "value": snake_case, "label": plain text }`. The default must match a declared option. | yes | `eq`, `neq`, `in`, `is_empty` |
| `multi_select` | `options` (1–50), `default` (array of option values) | Default values must be unique and declared. | yes | `eq`, `neq`, `contains`, `in`, `is_empty` |
| `member` | `multiple` (boolean, default `false`) | One member ID, or an array when `multiple` is `true`. | no | `eq`, `neq`, `in`, `is_empty`; `contains` only when `multiple` is `true` |
| `tags` | none | An array of up to 50 unique non-empty strings, each at most 80 characters. | yes | `eq`, `neq`, `contains`, `in`, `is_empty` |
| `relation` | `target_collection` (collection key), `multiple` (boolean, default `false`) | Must be optional (`required: false`). The target must be a declared collection. Records are linked after creation. | no | none; query through the relation endpoint |

`resource_ref` is a schema version `2` field type. `pnpm module:check` rejects version `2` manifests. <!-- packages/shared/src/modules.ts:151-229,726-740,867-888 -->

Every field type may appear in a view's `fields` list. Type restrictions apply only to `board.group_by`, `board.summary`, and `timeline.start_field`/`end_field`, as described under [Views](#views).

`required` means a record must contain a value. Defaults are applied to omitted fields at record creation and update time; they do not make a field required. <!-- packages/shared/src/modules.ts:422-473,1180-1187 -->

## Search

`search` is opt-in per collection.

| Key | Required | Constraints |
|---|---|---|
| `title_field` | yes | Declared field; not `relation` or `member`; must be `required` or have a `default`; must also appear in `fields`. |
| `subtitle_fields` | no | At most 3 entries, unique, each declared, each also in `fields`, and none may be `relation` or `member`. Defaults to `[]`. |
| `fields` | yes | 1–16 unique declared fields; none may be `relation` or `member`. |

Only `fields` enter the search projection, in order. Select and multi-select values project their labels. Title, subtitle, and text projections are capped at 200, 300, and 10,000 characters. <!-- packages/shared/src/modules.ts:306-316,1249-1294 -->

The two rules that most often fail a first manifest are:

- `title_field` must be listed in `search.fields`, or the check prints `Search fields must include title_field`.
- Every subtitle field must be listed in `search.fields`, or the check prints `Search fields must include subtitle field: <key>`.

Both errors point at `collections[n].search.fields`, even when the missing key is a subtitle. <!-- packages/shared/src/modules.ts:545-560 -->

## Views

Every view shares `key` (snake_case, unique per collection), `name`, `fields` (1–32 unique declared field keys), and optional `quick_filters` (at most 8; see below). Views are presentation hints only; they cannot contain queries, code, permissions, routes, or components.

| `type` | Extra keys | Rules |
|---|---|---|
| `table` | none | — |
| `board` | `group_by`, optional `summary` | `group_by` must reference a `single_select`, `member`, or `tags` field. `summary` is `{ "value_field": key, "unit_field": key }` and additionally requires `group_by` to be `single_select`, `value_field` to be `number`, and `unit_field` to be `single_select`. |
| `timeline` | `start_field`, optional `end_field` | Both must reference `date` or `datetime` fields. |
| `form` | none | Fields are the editable fields. |
| `detail` | none | Fields are the displayed fields. |

## Quick filters

Each view may declare up to 8 presets. A preset has `key` (snake_case, unique per view), `name`, and `filters` (1–16 entries). Filters in one preset are combined with AND. Selecting a preset replaces the view's current filter list.

### Filter value shape and supported field types

| Operator | Value shape | Supported field types | Notes |
|---|---|---|---|
| `eq`, `neq` | A value valid for the field: string, finite number, boolean, or array of strings. | All except `relation`. | Equality on `tags` and `multiple: true` `member` uses an array. |
| `contains` | String. | `text`, `long_text`, `email`, `url`, `multi_select`, `tags`, and `member` with `multiple: true`. | For `multi_select`, the value must be a declared option; for `tags` it must be a valid tag value; for a multi-member it must be a valid member ID. Text uses a case-insensitive substring match. |
| `in` | Array of strings. | `text`, `long_text`, `email`, `url`, `date`, `datetime`, `single_select`, `multi_select`, `member`, `tags`. | Not available for `number` or `boolean`. An empty array matches nothing. |
| `is_empty` | Boolean. | All except `relation`. | `true` matches null, `""`, and `[]`; `false` is the negation. |
| `date_relative` | One of `past`, `today`, `next_7_days`. | `date` only. | `datetime` is not accepted. `next_7_days` includes today. The runtime needs the caller's calendar day. |
| `gt`, `gte`, `lt`, `lte` | Number, or a date/datetime string. | `number`, `date`, `datetime`. | Numeric greater-than and less-than are supported. |

Comparison operators that do **not** exist in schema version 1 include `not_in`, `starts_with`, `ends_with`, regular-expression matching, null comparisons, OR groups, and nested filter groups. Reference fields (`relation`, and `resource_ref` in version 2) cannot be filtered at all; the parser prints `Reference fields must be queried through the relation endpoint`. <!-- packages/shared/src/modules.ts:231-304,1490-1531 -->

## Navigation

`navigation.default_collection` must reference a declared collection. `navigation.default_view`, when present, must be a view key on that collection. Omitting `navigation` lets the runtime choose the first collection. <!-- packages/shared/src/modules.ts:347-350,766-783 -->

## Cross-field validation rules

`pnpm module:check` prints these messages in a JSON array. Each row cites the enforcing code so maintainers can keep this table in sync.

| Rule | Exact message |
|---|---|
| Collection keys are unique. <!-- packages/shared/src/modules.ts:744-749 --> | `Collection keys must be unique` |
| Field keys are unique within a collection. <!-- packages/shared/src/modules.ts:501-506 --> | `Field keys must be unique` |
| Select option values are unique within a field. <!-- packages/shared/src/modules.ts:510-517 --> | `Select option values must be unique` |
| A field default must be valid for its type, option list, or required format. <!-- packages/shared/src/modules.ts:422-473 --> | `Default is invalid for <type>` |
| Relation fields must be optional. <!-- packages/shared/src/modules.ts:521-529 --> | `Relation fields must be optional in schema version 1` |
| Field keys cannot be reserved. <!-- packages/shared/src/modules.ts:104-109 --> | `Field key is reserved by Deft` |
| A relation target must exist. <!-- packages/shared/src/modules.ts:754-764 --> | `Relation target collection does not exist: <key>` |
| Search title, subtitle, and indexed fields must be declared. <!-- packages/shared/src/modules.ts:532-541 --> | `Search references unknown field: <key>` |
| Subtitle fields are unique. <!-- packages/shared/src/modules.ts:542 --> | `Subtitle fields must be unique` |
| Search fields are unique. <!-- packages/shared/src/modules.ts:543 --> | `Search fields must be unique` |
| The title field must be in `search.fields`. <!-- packages/shared/src/modules.ts:545-551 --> | `Search fields must include title_field` |
| Every subtitle field must be in `search.fields`. <!-- packages/shared/src/modules.ts:552-560 --> | `Search fields must include subtitle field: <key>` |
| The title field must be required or have a default. <!-- packages/shared/src/modules.ts:561-572 --> | `Search title_field must be required or have a default` |
| Search cannot index relations or members. <!-- packages/shared/src/modules.ts:573-582 --> | `Search cannot directly index relation field: <key>` or `Search cannot directly index member field: <key>` |
| View keys are unique within a collection. <!-- packages/shared/src/modules.ts:586-591 --> | `View keys must be unique` |
| View fields are unique within a view. <!-- packages/shared/src/modules.ts:593 --> | `View fields must be unique` |
| Every view field must be declared. <!-- packages/shared/src/modules.ts:594-602 --> | `View references unknown field: <key>` |
| Quick-filter keys are unique within a view. <!-- packages/shared/src/modules.ts:603 --> | `Quick filters must be unique` |
| A quick filter must reference a declared non-reference field. <!-- packages/shared/src/modules.ts:606-610 --> | `Quick filter must reference a non-reference collection field` |
| Reference fields cannot be filtered. <!-- packages/shared/src/modules.ts:241-243 --> | `Reference fields must be queried through the relation endpoint` |
| `date_relative` requires a date field. <!-- packages/shared/src/modules.ts:244-246 --> | `date_relative requires a date field` |
| `date_relative` has a closed value set. <!-- packages/shared/src/modules.ts:1497-1499 --> | `date_relative requires past, today or next_7_days` |
| `is_empty` takes a boolean. <!-- packages/shared/src/modules.ts:1500-1502 --> | `is_empty requires a boolean value` |
| `contains` takes a string. <!-- packages/shared/src/modules.ts:252-253,1503-1509 --> | `contains requires a string value` |
| `contains` on a multi-select must name a declared option. <!-- packages/shared/src/modules.ts:254-258 --> | `contains value for <key> must match a declared option` |
| `contains` on tags or a multi-member must be a valid value. <!-- packages/shared/src/modules.ts:259-262 --> | `contains value for <key>: <issue>` |
| `contains` is limited to text-like and multi-value fields. <!-- packages/shared/src/modules.ts:263-265 --> | `contains is only valid for text or multi-select fields` |
| `in` takes an array of strings. <!-- packages/shared/src/modules.ts:267-270,1510-1519 --> | `in requires an array of string values` |
| `in` has a closed field-type list. <!-- packages/shared/src/modules.ts:271-282 --> | `in is not valid for this field type` |
| `in` values must be valid for the field. <!-- packages/shared/src/modules.ts:283-296 --> | `in value for <key>: <issue>` or `in value for <key> must match a declared option` |
| `gt`, `gte`, `lt`, and `lte` take a number or date/datetime. <!-- packages/shared/src/modules.ts:1520-1530 --> | `<operator> requires a number, date, or datetime value` |
| `gt`, `gte`, `lt`, and `lte` are limited to number/date fields. <!-- packages/shared/src/modules.ts:299-301 --> | `<operator> is only valid for number/date fields` |
| Comparison values must be valid for the field. <!-- packages/shared/src/modules.ts:302-303 --> | `<operator> value for <key>: <issue>` |
| Board summary needs a number value and select group/unit. <!-- packages/shared/src/modules.ts:622-628 --> | `Summary requires a number value and single-select group and unit fields` |
| Board `group_by` must be declared. <!-- packages/shared/src/modules.ts:629-634 --> | `Board references unknown field: <key>` |
| Board `group_by` has a closed type list. <!-- packages/shared/src/modules.ts:635-641 --> | `Board group_by must reference a select, member, or tags field` |
| Timeline start/end fields must be declared. <!-- packages/shared/src/modules.ts:647-653 --> | `Timeline references unknown field: <key>` |
| Timeline start/end fields must be dates. <!-- packages/shared/src/modules.ts:654-660 --> | `Timeline field must be a date or datetime: <key>` |
| Latest-related keys are unique. <!-- packages/shared/src/modules.ts:709 --> | `Related summary keys must be unique` |
| A latest-related summary needs a direct relation, a date, and declared select values. <!-- packages/shared/src/modules.ts:704-724 --> | `Latest related summary requires a direct relation to this collection, a date field and declared select values` |
| The default collection must exist. <!-- packages/shared/src/modules.ts:766-773 --> | `Default collection must reference a declared collection` |
| The default view must belong to the default collection. <!-- packages/shared/src/modules.ts:774-783 --> | `Default view must belong to the default collection` |

## What a version 1 Module cannot do

| Capability | Available in v1? | Use instead |
|---|---|---|
| Conditional, cross-field, or role-based validation | No. Fields accept only type, `required`, `default`, and select options. | Enforce the rule in your process, or package the resources as an App and keep the check outside the manifest. Start with [Build an internal App](getting-started.md#build-an-internal-app). |
| Status-transition guards or a workflow state machine | No. A `single_select` status is ordinary data. | Same as above; Module records do not execute rules. |
| Seed or sample records in the manifest | No. `module:init` writes an empty `fixtures/demo-records.json` authoring file, and `module:check` does not install it. | Create records through the UI or governed module operations after install. For a packaged app, use the App path. |
| Computed fields, formulas, or rollups | No. `board.summary` totals one number field at render time only. | Compute the value outside the Module. |
| Code, custom UI, webhooks, network calls, SQL, triggers, migrations, or secrets | No. The manifest is closed JSON. | The App path. |
| Private rows, collections, or fields | No. Records are visible to workspace owners, admins, and members; guests are denied. | Do not put restricted data in a v1 Module. |
| Automatic upgrades or author migrations | No. Installed versions are immutable; an update installs a new version. | Follow the tutorial's update step. |

## Minimal complete manifest

This manifest passes `pnpm module:check`. It declares one searchable collection with a numeric quick filter and table, board, form, and detail views.

```json
{
  "schema_version": "1",
  "id": "community.example.invoice-tracker",
  "slug": "invoice-tracker",
  "version": "0.1.0",
  "name": "Invoice tracker",
  "description": "Invoices with amounts, due dates, and approval status.",
  "icon": "briefcase",
  "navigation": {
    "default_collection": "invoices",
    "default_view": "table"
  },
  "collections": [
    {
      "key": "invoices",
      "name": "Invoices",
      "singular_name": "Invoice",
      "fields": [
        {
          "key": "invoice_number",
          "label": "Invoice number",
          "type": "text",
          "required": true
        },
        {
          "key": "amount",
          "label": "Amount",
          "type": "number",
          "required": true
        },
        {
          "key": "due_date",
          "label": "Due date",
          "type": "date"
        },
        {
          "key": "status",
          "label": "Status",
          "type": "single_select",
          "options": [
            { "value": "draft", "label": "Draft" },
            { "value": "approved", "label": "Approved" }
          ],
          "default": "draft"
        },
        {
          "key": "notes",
          "label": "Notes",
          "type": "long_text"
        }
      ],
      "search": {
        "title_field": "invoice_number",
        "subtitle_fields": ["status"],
        "fields": ["invoice_number", "status", "amount"]
      },
      "views": [
        {
          "key": "table",
          "name": "All invoices",
          "type": "table",
          "fields": ["invoice_number", "amount", "due_date", "status"],
          "quick_filters": [
            {
              "key": "over_5000",
              "name": "Over 5,000",
              "filters": [
                { "field": "amount", "operator": "gt", "value": 5000 }
              ]
            }
          ]
        },
        {
          "key": "board",
          "name": "By status",
          "type": "board",
          "group_by": "status",
          "fields": ["invoice_number", "amount", "due_date"]
        },
        {
          "key": "form",
          "name": "New invoice",
          "type": "form",
          "fields": ["invoice_number", "amount", "due_date", "status", "notes"]
        },
        {
          "key": "detail",
          "name": "Details",
          "type": "detail",
          "fields": ["invoice_number", "amount", "due_date", "status", "notes"]
        }
      ]
    }
  ]
}
```

Validate it from a Deft checkout:

```bash
pnpm module:check ./path/to/invoice-tracker
```

A passing check prints the identity and a canonical digest:

```text
community.example.invoice-tracker@0.1.0
sha256:<64 lowercase hex characters>
```

A failing check prints a JSON array of issues and no digest. `pnpm module:format ./path/to/invoice-tracker` rewrites the file canonically; the digest does not change.

## Limits

| Limit | Value |
|---|---|
| Manifest size | 128 KiB of UTF-8 JSON |
| Collections per Module | 1–8 |
| Fields per collection | 1–64 |
| Select options per field | 1–50 |
| Views per collection | 8 |
| Fields per view | 1–32 |
| Quick filters per view | 8 |
| Filters per quick filter | 1–16 |
| Search fields per collection | 1–16 |
| Search subtitle fields | 3 |
| Latest-related summaries per collection | 4 |
| Record size after defaults | 256 KiB |
| Text value | 10,000 characters |
| Long-text value | 100,000 characters |
| Email value | 320 characters |
| URL value | 2,048 characters |

<!-- packages/shared/src/modules.ts:17-45 -->
