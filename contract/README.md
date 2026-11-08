# Lab contract

JSON Schemas (draft 2020-12) for what a lab serves to EnrichedLab. Version `2026-11`; a lab states its version in its
descriptor, and a client refuses a different major. New fields are optional and clients ignore fields they don't know.

| File | Endpoint |
| --- | --- |
| `lab.schema.json` | `GET /.well-known/enrichedlab-lab` |
| `me.schema.json` | `GET /v1/me` |
| `models.schema.json` | `GET /v1/models` |
| `bundles.schema.json` | `GET /v1/bundles` |
| `event.schema.json` | each event on `GET /v1/events` |
| `guard.schema.json` | `POST /v1/guard` answer |
| `usage.schema.json` | `GET /v1/usage` |
| `container.schema.json` | `POST /v1/containers` answer |
| `apps.schema.json` | `GET /v1/apps` |
| `signers.schema.json` | `GET /v1/signers` |
| `desktop.schema.json` | `POST /v1/containers/{id}/desktop` action and answer, and `.../desktop/open` |
| `run.schema.json` | `/v1/runs` (proposed): create, run, message, decision |
| `checkpoint.schema.json` | `/v1/containers/{id}/checkpoints`: make, list, restore, delete |

`el lab check <lab>` checks a running lab against these. What each endpoint is for: [docs/labs.md](../docs/labs.md).
