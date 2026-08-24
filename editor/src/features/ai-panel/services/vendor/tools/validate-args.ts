/**
 * Tool-argument validation — the check that was missing entirely.
 *
 * Every tool in this harness declares a TypeBox schema and, until this module,
 * NOTHING ever checked a call against it: each tool blind-cast its params
 * (`params as WriteToolInput`) and ran. What the model emitted was taken as
 * fact. Two consequences we actually hit:
 *
 *  - `read` with `limit: -5` returned the file MINUS its last five lines, and
 *    labelled the result as the whole file. Silently wrong data, no error.
 *  - `write` with a missing `content` reached `ops.writeFile` and only failed
 *    because Rust's `write_file(path: String, contents: String)` rejects it at
 *    the serde boundary — after which `content.split('\n')` threw, so the model
 *    was told `Cannot read properties of undefined (reading 'split')`. A model
 *    cannot act on that. It CAN act on "missing required parameter: content".
 *
 * Order matters: `Default` fills schema defaults, `Convert` absorbs the common
 * `"3"`-for-`3` stringly-typed emission, and only then does `Check` decide. All
 * three are non-mutating (we clone first), so a rejected call leaves the
 * assistant message exactly as the model produced it.
 *
 * `Type.Object` does not set `additionalProperties: false`, so extra keys stay
 * tolerated — this rejects malformed calls, not creative ones.
 */

import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/** How many individual field errors to show the model before truncating. */
const MAX_REPORTED_ERRORS = 4;
/** How much of an unparseable argument blob to quote back. */
const MAX_RAW_ECHO = 300;

export type ArgValidation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

function describe(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validate (and lightly coerce) one tool call's arguments.
 *
 * `rawArguments` is set when the transport could not parse the model's argument
 * blob as JSON at all. That case must be reported as a JSON failure rather than
 * a schema failure, because the two need different corrections from the model —
 * and because the alternative (what used to happen) was executing the tool with
 * the `{}` the block was initialised with.
 */
export function validateToolArgs(
  toolName: string,
  schema: TSchema,
  args: unknown,
  rawArguments?: string,
): ArgValidation {
  if (typeof rawArguments === 'string') {
    const echo =
      rawArguments.length > MAX_RAW_ECHO
        ? `${rawArguments.slice(0, MAX_RAW_ECHO)}… (${rawArguments.length} chars)`
        : rawArguments;
    return {
      ok: false,
      message:
        `Error: the arguments for "${toolName}" were not valid JSON, so the tool was NOT executed. ` +
        `Received: ${echo || '(empty)'}\n` +
        `Re-issue the call with well-formed JSON arguments.`,
    };
  }

  // Clone before Default/Convert: these return new values for objects, but the
  // assistant message this came from is already in history and must not shift.
  let candidate: unknown;
  try {
    candidate = Value.Convert(schema, Value.Default(schema, structuredClone(args ?? {})));
  } catch {
    candidate = args ?? {};
  }

  if (Value.Check(schema, candidate)) {
    return { ok: true, value: candidate as Record<string, unknown> };
  }

  const problems: string[] = [];
  for (const err of Value.Errors(schema, candidate)) {
    if (problems.length >= MAX_REPORTED_ERRORS) {
      problems.push('…(further errors omitted)');
      break;
    }
    problems.push(`  ${err.path || '/'}: ${err.message} (got ${describe(err.value)})`);
  }

  return {
    ok: false,
    message:
      `Error: invalid arguments for "${toolName}", so the tool was NOT executed.\n` +
      `${problems.join('\n')}\n` +
      `Fix the arguments and call the tool again.`,
  };
}
