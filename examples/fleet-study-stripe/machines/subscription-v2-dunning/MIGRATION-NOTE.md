# MIGRATION-NOTE — contract 158a714e5fba → efa70d4dfb31

## Why the shape changed

TODO(human): one paragraph.

## What each hole maps

- retyped key 'dunningAttempts' (integer 0..3 — retries burned against the current unpaid invoice → integer 0..2 — retries burned against the current unpaid invoice) — the scaffold throws until a human writes the conversion

## Meaning-gap instances

TODO(human): named instances (if any) with no honest image in the new
shape, and what was decided about them. Delete this section if none.
