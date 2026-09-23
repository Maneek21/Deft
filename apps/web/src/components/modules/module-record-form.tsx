'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { AppDialog } from '@/components/overlay-primitives';
import { useModuleMembers } from '@/hooks/use-modules';
import { ModuleRelationInput } from './module-relation-input';
import { initialModuleRelationValues, moduleFormRelationPatch } from '@/lib/module-form-relations';
import {
  diffModuleRecordUpdate,
  getModuleCollectionFields,
  getModuleCreatePrimaryFields,
  initialModuleRecordValues,
  moduleRecordPayload,
  validateModuleRecordValues,
  type ModuleCollection,
  type ModuleField,
  type ModuleMember,
  type ModuleRecord,
  type ModuleRelationGroup,
} from '@/lib/modules';

export function ModuleRecordFormDialog({
  open,
  collection,
  slug,
  collections,
  initialRelations = [],
  initialData,
  record,
  onClose,
  onSubmit,
}: {
  open: boolean;
  collection: ModuleCollection;
  slug: string;
  collections: ModuleCollection[];
  initialRelations?: ModuleRelationGroup[];
  initialData?: Record<string, unknown>;
  record?: ModuleRecord | null;
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>, idempotencyKey: string, unsetFields: string[], relations: Record<string, string[]>) => Promise<void>;
}) {
  const memberState = useModuleMembers(collection.fields.some((field) => field.type === 'member'));
  const initialValues = useMemo(
    () => ({ ...initialModuleRecordValues(collection, record, initialData), ...initialModuleRelationValues(collection, record?.relations ?? initialRelations) }),
    [collection, record, initialRelations, initialData],
  );
  const [values, setValues] = useState<Record<string, unknown>>(initialValues);
  const [changedFields, setChangedFields] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [optionalOpen, setOptionalOpen] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(createIntentKey);
  const wasOpenRef = useRef(false);
  const submitErrorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setValues(initialValues);
      setErrors({});
      setSubmitError(null);
      setChangedFields(new Set());
      setIdempotencyKey(createIntentKey());
      setOptionalOpen(false);
    }
    wasOpenRef.current = open;
  }, [initialValues, open]);

  useEffect(() => {
    if (!submitError) return;
    submitErrorRef.current?.focus();
    submitErrorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [submitError]);

  const fields = useMemo(() => {
    const configuredFields = getModuleCollectionFields(collection, 'form');
    const selected = (configuredFields.length > 0 ? configuredFields : collection.fields)
      .filter((field) => field.type !== 'resource_ref');
    const required = collection.fields.filter((field) => (
      field.type !== 'resource_ref'
      && field.required
      && !selected.some((candidate) => candidate.key === field.key)
    ));
    return [...selected, ...required];
  }, [collection]);

  const visibleFields = useMemo(() => {
    if (record) return fields;
    const essentialKeys = new Set(getModuleCreatePrimaryFields(fields).map((field) => field.key));
    if (collection.titleField) essentialKeys.add(collection.titleField);
    for (const key of Object.keys(initialData ?? {})) essentialKeys.add(key);
    for (const relation of initialRelations) essentialKeys.add(relation.fieldKey);
    return fields.filter((field) => field.required || essentialKeys.has(field.key));
  }, [collection.titleField, fields, initialData, initialRelations, record]);
  const optionalFields = record ? [] : fields.filter((field) => !visibleFields.some((visible) => visible.key === field.key));

  const setValue = (key: string, value: unknown) => {
    setValues((current) => ({ ...current, [key]: value }));
    setChangedFields((current) => new Set(current).add(key));
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const validation = validateModuleRecordValues(collection, values);
    setErrors(validation);
    if (optionalFields.some((field) => field.key in validation)) setOptionalOpen(true);
    if (Object.keys(validation).length > 0) return;

    const payload = moduleRecordPayload(collection, values);
    const relations = moduleFormRelationPatch(collection, values, changedFields, Boolean(record));
    const update = record ? diffModuleRecordUpdate(record.data, payload, changedFields) : null;
    const outgoing = update?.patch ?? payload;
    if (record && Object.keys(outgoing).length === 0 && update?.unsetFields.length === 0 && Object.keys(relations).length === 0) {
      onClose();
      return;
    }

    setBusy(true);
    setSubmitError(null);
    try {
      await onSubmit(outgoing, idempotencyKey, update?.unsetFields ?? [], relations);
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Unable to save this record.');
    } finally {
      setBusy(false);
    }
  };

  const title = record ? `Edit ${collection.singularName}` : `New ${collection.singularName}`;
  return (
    <AppDialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      description={record ? `Update this ${collection.singularName.toLowerCase()}.` : `Create a new record in ${collection.name}.`}
      width={620}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-10 rounded-full px-4 text-[0.8125rem] font-medium disabled:opacity-50"
            style={{ color: 'var(--on-surface-variant)', background: 'var(--surface-container-low)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="module-record-form"
            disabled={busy}
            className="flex min-h-10 items-center justify-center gap-2 rounded-full px-4 text-[0.8125rem] font-medium text-white disabled:opacity-60"
            style={{ background: 'var(--primary-container)' }}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {record ? 'Save changes' : `Create ${collection.singularName.toLowerCase()}`}
          </button>
        </div>
      }
    >
      <form id="module-record-form" className="space-y-4" onSubmit={handleSubmit}>
        {submitError && (
          <div
            ref={submitErrorRef}
            role="alert"
            tabIndex={-1}
            className="rounded-lg px-3 py-2 text-[0.8125rem]"
            style={{ color: 'var(--on-surface)', background: 'var(--danger-subtle)' }}
          >
            {submitError}
          </div>
        )}
        {fields.length === 0 ? (
          <div className="rounded-lg px-4 py-5 text-[0.8125rem]" style={{ background: 'var(--surface-container-low)', color: 'var(--on-surface-variant)' }}>
            This collection has no editable fields.
          </div>
        ) : visibleFields.map((field) => field.type === 'relation' ? (
          <ModuleRelationInput key={field.key} slug={slug} field={field} targetCollection={collections.find((candidate) => candidate.key === field.targetCollection)} value={values[field.key]} initial={record?.relations ?? initialRelations} error={errors[field.key]} disabled={busy} onChange={(ids) => setValue(field.key, ids)} />
        ) : (
          <ModuleFieldInput
            key={field.key}
            field={field}
            value={values[field.key]}
            error={errors[field.key]}
            members={memberState.members}
            onChange={(value) => setValue(field.key, value)}
          />
        ))}
        {optionalFields.length > 0 && (
          <details
            open={optionalOpen}
            onToggle={(event) => setOptionalOpen(event.currentTarget.open)}
            className="rounded-xl border px-3 py-2"
            style={{ borderColor: 'var(--outline-variant)' }}
          >
            <summary className="min-h-11 cursor-pointer py-2 text-[0.8125rem] font-medium" style={{ color: 'var(--on-surface)' }}>
              More details <span className="ml-1 text-[0.6875rem] font-normal" style={{ color: 'var(--on-surface-variant)' }}>Optional</span>
            </summary>
            <div className="space-y-4 pb-2">
              {optionalFields.map((field) => field.type === 'relation' ? (
                <ModuleRelationInput key={field.key} slug={slug} field={field} targetCollection={collections.find((candidate) => candidate.key === field.targetCollection)} value={values[field.key]} initial={record?.relations ?? initialRelations} error={errors[field.key]} disabled={busy} onChange={(ids) => setValue(field.key, ids)} />
              ) : (
                <ModuleFieldInput
                  key={field.key}
                  field={field}
                  value={values[field.key]}
                  error={errors[field.key]}
                  members={memberState.members}
                  onChange={(value) => setValue(field.key, value)}
                />
              ))}
            </div>
          </details>
        )}
      </form>
    </AppDialog>
  );
}

function createIntentKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `module-write-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function ModuleFieldInput({
  field,
  value,
  error,
  members,
  onChange,
}: {
  field: ModuleField;
  value: unknown;
  error?: string;
  members: ModuleMember[];
  onChange: (value: unknown) => void;
}) {
  const inputId = `module-field-${field.key}`;
  const helpId = `${inputId}-help`;
  const inputStyle = {
    background: 'var(--surface-container-low)',
    color: 'var(--on-surface)',
    border: `1px solid ${error ? 'var(--error)' : 'var(--outline-variant)'}`,
  };

  let control: ReactNode;
  if (field.type === 'long_text') {
    control = (
      <textarea
        id={inputId}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        required={field.required}
        rows={5}
        aria-invalid={Boolean(error)}
        aria-describedby={field.description || error ? helpId : undefined}
        className="w-full resize-y rounded-lg px-3 py-2.5 text-[0.875rem] outline-none focus:ring-2 focus:ring-[var(--input-focus)]"
        style={inputStyle}
      />
    );
  } else if (field.type === 'boolean') {
    control = (
      <label
        htmlFor={inputId}
        className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg px-3"
        style={inputStyle}
      >
        <span className="text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)' }}>
          {Boolean(value) ? 'Enabled' : 'Disabled'}
        </span>
        <input
          id={inputId}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 accent-[var(--primary-container)]"
        />
      </label>
    );
  } else if (field.type === 'single_select') {
    control = (
      <select
        id={inputId}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        required={field.required}
        aria-invalid={Boolean(error)}
        aria-describedby={field.description || error ? helpId : undefined}
        className="min-h-11 w-full rounded-lg px-3 text-[0.875rem] outline-none focus:ring-2 focus:ring-[var(--input-focus)]"
        style={inputStyle}
      >
        <option value="">Select an option</option>
        {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  } else if (field.type === 'multi_select' || (field.type === 'member' && field.multiple)) {
    const selected = Array.isArray(value) ? value.map(String) : [];
    const options = field.type === 'member'
      ? members.map((member) => ({ value: member.id, label: member.name }))
      : field.options;
    control = (
      <div className="grid max-h-64 gap-2 overflow-y-auto rounded-lg p-2 sm:grid-cols-2" style={inputStyle}>
        {options.length === 0 ? (
          <p className="px-2 py-1 text-[0.75rem] sm:col-span-2" style={{ color: 'var(--on-surface-variant)' }}>
            {field.type === 'member' ? 'No workspace members are available.' : 'No options are configured.'}
          </p>
        ) : options.map((option) => {
          const checked = selected.includes(option.value);
          return (
            <label
              key={option.value}
              className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 text-[0.8125rem]"
              style={{ background: checked ? 'var(--bg-active)' : 'transparent' }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onChange(checked
                  ? selected.filter((entry) => entry !== option.value)
                  : [...selected, option.value])}
                className="h-4 w-4 accent-[var(--primary-container)]"
              />
              {option.label}
            </label>
          );
        })}
      </div>
    );
  } else if (field.type === 'member') {
    control = (
      <select
        id={inputId}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        required={field.required}
        aria-invalid={Boolean(error)}
        aria-describedby={field.description || error ? helpId : undefined}
        className="min-h-11 w-full rounded-lg px-3 text-[0.875rem] outline-none focus:ring-2 focus:ring-[var(--input-focus)]"
        style={inputStyle}
      >
        <option value="">Select a member</option>
        {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select>
    );
  } else if (field.type === 'tags') {
    const textValue = Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'string' ? value : '';
    const tags = textValue.split(',').map((tag) => tag.trim()).filter(Boolean);
    control = (
      <div>
        <input
          id={inputId}
          type="text"
          value={textValue}
          onChange={(event) => onChange(event.target.value)}
          required={field.required}
          aria-invalid={Boolean(error)}
          aria-describedby={field.description || error ? helpId : undefined}
          placeholder="Add tags, separated by commas"
          className="min-h-11 w-full rounded-lg px-3 text-[0.875rem] outline-none focus:ring-2 focus:ring-[var(--input-focus)]"
          style={inputStyle}
        />
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span key={tag} className="rounded-full px-2 py-0.5 text-[0.6875rem]" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  } else {
    const type = field.type === 'number'
      ? 'number'
      : field.type === 'date'
        ? 'date'
        : field.type === 'datetime'
          ? 'datetime-local'
          : field.type;
    control = (
      <input
        id={inputId}
        type={type}
        step={field.type === 'number' ? 'any' : undefined}
        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        required={field.required}
        aria-invalid={Boolean(error)}
        aria-describedby={field.description || error ? helpId : undefined}
        className="min-h-11 w-full rounded-lg px-3 text-[0.875rem] outline-none focus:ring-2 focus:ring-[var(--input-focus)]"
        style={inputStyle}
      />
    );
  }

  return (
    <div>
      <FieldLabel field={field} htmlFor={inputId} />
      {control}
      {(field.description || error) && (
        <p id={helpId} className="mt-1 text-[0.6875rem]" style={{ color: error ? 'var(--error)' : 'var(--outline)' }}>
          {error ?? field.description}
        </p>
      )}
    </div>
  );
}

function FieldLabel({ field, htmlFor }: { field: ModuleField; htmlFor: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[0.75rem] font-medium" style={{ color: 'var(--on-surface-variant)' }}>
      {field.label}
      {field.required && <span aria-hidden className="ml-1" style={{ color: 'var(--error)' }}>*</span>}
    </label>
  );
}
