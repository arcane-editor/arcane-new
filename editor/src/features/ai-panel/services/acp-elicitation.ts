/**
 * Turning an ACP form elicitation into questions Arcane already knows how to
 * ask, and turning the answers back into the shape the agent expects.
 *
 * This is how Claude Code's `AskUserQuestion` reaches the user. Rather than
 * building a second question UI, an elicitation is decomposed into the same
 * `ask_user` questions the Arcane agent raises, so both agents render through
 * `QuestionBlock`, answer through the composer, and cancel through the same
 * gate. A chat transcript is sequential anyway: asking two questions in a row
 * reads better than a form, and costs no new UI.
 *
 * The one shape that needs care is the per-question "Other" field the adapter
 * appends (`question_<n>_custom`). It is not a question of its own — it is the
 * slot a TYPED answer belongs in, as opposed to a picked one. Folding it into
 * its parent here is what makes "click a chip" and "type your own" both work
 * without asking the user twice.
 *
 * Pure: no store, no client, no I/O — every branch is unit-testable.
 */

import {
  ASK_CUSTOM_ANSWER_META,
  ASK_OPTION_META,
  type CreateElicitationParams,
  type ElicitationPropertySchema,
  type ElicitationValue,
  type EnumOption,
} from '../../acp';
import type { AskUserOption } from './ask-user-tool';

export type ElicitationFieldKind = 'select' | 'multiselect' | 'boolean' | 'number' | 'text';

export interface ElicitationChoice extends AskUserOption {
  /** The value to send back, which is not always the label. */
  value: string;
  /** A mockup or code snippet the agent attached to this choice. */
  preview?: string;
}

export interface ElicitationField {
  key: string;
  kind: ElicitationFieldKind;
  title?: string;
  description?: string;
  choices?: ElicitationChoice[];
  /** Key of the sibling free-text field that takes a typed answer instead. */
  customKey?: string;
  required: boolean;
}

export interface ElicitationForm {
  message: string;
  fields: ElicitationField[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The question this free-text field is the "Other" box for, if it is one. */
export function customAnswerParent(schema: ElicitationPropertySchema): string | null {
  const meta = schema._meta?.[ASK_CUSTOM_ANSWER_META];
  if (!isRecord(meta)) return null;
  const parent = meta.questionId;
  return typeof parent === 'string' && parent ? parent : null;
}

function previewOf(option: EnumOption): string | undefined {
  const meta = option._meta?.[ASK_OPTION_META];
  if (!isRecord(meta)) return undefined;
  return typeof meta.preview === 'string' ? meta.preview : undefined;
}

function choicesFrom(schema: ElicitationPropertySchema): ElicitationChoice[] | undefined {
  const enumOptions = schema.oneOf ?? schema.items?.anyOf;
  if (enumOptions?.length) {
    return enumOptions
      .filter((o): o is EnumOption => typeof o?.const === 'string')
      .map((o) => ({
        label: o.title || o.const,
        value: o.const,
        description: o.description ?? undefined,
        preview: previewOf(o),
      }));
  }
  // MCP servers commonly send a bare string enum with no titles.
  const bare = schema.enum ?? schema.items?.enum;
  if (bare?.length) return bare.map((value) => ({ label: value, value }));
  return undefined;
}

function kindOf(schema: ElicitationPropertySchema, hasChoices: boolean): ElicitationFieldKind {
  if (schema.type === 'array') return 'multiselect';
  if (schema.type === 'boolean') return 'boolean';
  if (hasChoices) return 'select';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  // An unknown or future type is asked as free text rather than dropped: a
  // question the user can still answer beats a silently skipped one.
  return 'text';
}

/**
 * Decompose a form elicitation into the questions to ask, in order.
 * Returns null when there is nothing answerable, so the caller can decline
 * rather than render an empty card.
 */
export function parseElicitationForm(params: CreateElicitationParams): ElicitationForm | null {
  const properties = params.requestedSchema?.properties;
  if (!isRecord(properties)) return null;

  const required = new Set(params.requestedSchema?.required ?? []);
  const customFor = new Map<string, string>(); // parent key -> custom field key
  for (const [key, schema] of Object.entries(properties)) {
    const parent = customAnswerParent(schema);
    if (parent) customFor.set(parent, key);
  }

  const fields: ElicitationField[] = [];
  for (const [key, schema] of Object.entries(properties)) {
    if (customAnswerParent(schema)) continue; // folded into its parent below
    const choices = choicesFrom(schema);
    fields.push({
      key,
      kind: kindOf(schema, !!choices?.length),
      title: schema.title ?? undefined,
      description: schema.description ?? undefined,
      choices,
      customKey: customFor.get(key),
      required: required.has(key),
    });
  }

  return fields.length > 0 ? { message: params.message, fields } : null;
}

/**
 * The text to show for one field. With a single field the elicitation's own
 * message IS the question, so repeating the field title under it would say the
 * same thing twice.
 */
export function questionTextFor(form: ElicitationForm, field: ElicitationField): string {
  if (form.fields.length === 1) return form.message || field.description || field.title || 'Choose one';
  return field.description || field.title || form.message;
}

/** Yes/No are rendered as ordinary choices — a boolean is a two-option question. */
const BOOLEAN_CHOICES: ElicitationChoice[] = [
  { label: 'Yes', value: 'true' },
  { label: 'No', value: 'false' },
];

export function choicesFor(field: ElicitationField): ElicitationChoice[] | undefined {
  if (field.kind === 'boolean') return BOOLEAN_CHOICES;
  return field.choices;
}

/**
 * Encode one answer into the form's content object.
 *
 * A picked answer matches a choice label and is sent as that choice's value.
 * Anything else is a typed answer, which belongs in the sibling "Other" field
 * when the agent offered one — that is exactly how the adapter distinguishes
 * "chose option B" from "wrote their own", and putting free text in the enum
 * slot instead would be read back as an invalid selection and dropped.
 */
export function encodeAnswer(
  field: ElicitationField,
  answer: string,
): Record<string, ElicitationValue> {
  const trimmed = answer.trim();
  if (trimmed === '') return {};

  const choices = choicesFor(field);

  if (field.kind === 'multiselect') {
    const wanted = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    const values = wanted
      .map((label) => choices?.find((c) => c.label === label)?.value)
      .filter((v): v is string => v !== undefined);
    if (values.length > 0) return { [field.key]: values };
    return field.customKey ? { [field.customKey]: trimmed } : { [field.key]: wanted };
  }

  const picked = choices?.find((c) => c.label === trimmed || c.value === trimmed);
  if (picked) {
    if (field.kind === 'boolean') return { [field.key]: picked.value === 'true' };
    return { [field.key]: picked.value };
  }

  if (field.customKey) return { [field.customKey]: trimmed };

  if (field.kind === 'number') {
    const n = Number(trimmed);
    return Number.isFinite(n) ? { [field.key]: n } : { [field.key]: trimmed };
  }
  if (field.kind === 'boolean') {
    return { [field.key]: /^(y|yes|true|1)$/i.test(trimmed) };
  }
  return { [field.key]: trimmed };
}
