// sha256 of an SVG string (spec §3.4 --hash). Determinism/CI check.
import { createHash } from 'node:crypto';

export function sha256(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}
