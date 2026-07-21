// The viz-model JSON Schema (spec §4.2). `polyviz schema` prints this verbatim.
// The viz-model is the stable contract between adapters and renderers; every
// mark a renderer draws traces to a field here. Scorecard/choice (the DAAO
// marketing figure) are intentionally excluded — the catalog is bug-and-fix.

export const SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://cognitivefab.com/polyviz/viz-model.schema.json',
  title: 'polyviz viz-model',
  type: 'object',
  additionalProperties: false,
  properties: {
    meta: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        subtitle: { type: 'string' },
        kicker: { type: 'string' },
        theme: { enum: ['dark', 'light'] },
        brand: { type: 'string' },
        footer: { type: 'string' }
      }
    },
    machine: {
      type: 'object',
      additionalProperties: false,
      required: ['states', 'transitions'],
      properties: {
        kicker: { type: 'string' },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        states: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              kind: { enum: ['normal', 'terminal', 'highlight'] },
              role: { type: 'string' }
            }
          }
        },
        transitions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['from', 'to', 'event'],
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              event: { type: 'string' },
              guard: { type: 'string' },
              effect: { type: 'string' },
              emphasis: { enum: ['none', 'accent', 'violation'] },
              note: { type: 'string' }
            }
          }
        }
      }
    },
    invariants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text'],
        properties: {
          id: { type: 'string' },
          kind: { enum: ['safety', 'liveness'] },
          text: { type: 'string' },
          status: { enum: ['pass', 'fail', 'unchecked'] }
        }
      }
    },
    trace: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kicker: { type: 'string' },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label'],
            properties: {
              label: { type: 'string' },
              kind: { enum: ['normal', 'redelivered', 'approved', 'violation'] },
              annotation: { type: 'string' }
            }
          }
        },
        violation: {
          type: 'object',
          additionalProperties: false,
          properties: {
            invariantId: { type: 'string' },
            title: { type: 'string' },
            detail: { type: 'string' }
          }
        },
        callout: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            cleanPasses: { type: 'boolean' }
          }
        }
      }
    },
    compat: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kicker: { type: 'string' },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        gate: { type: 'string' },
        fleetLabel: { type: 'string' },
        from: { $ref: '#/$defs/versionCard' },
        to: { $ref: '#/$defs/versionCard' },
        fleet: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'state'],
            properties: {
              id: { type: 'string' },
              state: { type: 'string' },
              note: { type: 'string' },
              flagged: { type: 'boolean' }
            }
          }
        },
        verdict: {
          type: 'object',
          additionalProperties: false,
          required: ['status'],
          properties: {
            status: { enum: ['blocked', 'clear'] },
            title: { type: 'string' },
            detail: { type: 'string' },
            offenders: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    }
  },
  $defs: {
    versionCard: {
      type: 'object',
      additionalProperties: false,
      required: ['label'],
      properties: { label: { type: 'string' }, detail: { type: 'string' } }
    }
  }
};
