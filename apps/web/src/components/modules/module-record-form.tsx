'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { AppDialog } from '@/components/overlay-primitives';
import {
  diffModuleRecordUpdate,
  getModuleCollectionFields,
  initialModuleRecordValues,
  moduleRecordPayload,
  validateModuleRecordValues,
  type ModuleCollection,
  type ModuleField,
  type ModuleRecord,
} from '@/lib/modules';

export function ModuleRecordFormDialog({
  open,
  collection,
  record,
  onClose,
  onSubmit,
}: {
  open: boolean;
  collection: ModuleCollection;
  record?: ModuleRecord | null;
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>, idempotencyKey: string, unsetFields: string[]) => Promise<void>;
}) {
  const initialValues = useMemo(
    () => initialModuleRecordValues(collection, record),
    [collection, record],
  );
  const [values, setValues] = useState<Record<string, unknown>>(initialValues);
  const [changedFields, setChangedFields] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(createIntentKey);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setValues(initialValues);
      setErrors({});
      setSubmitError(null);
      setChangedFields(new Set());
      setIdempotencyKey(createIntentKey());
    }
    wasOpenRef.current = open;
  }, [initialValues, open]);

  const fields = useMemo(() => {
    const configuredFields = getModuleCollectionFields(collection, 'form');
    const selected = configuredFields.length > 0 ? configuredFields : collection.fields;
    const required = collection.fields.filter((field) => field.required && !selected.some((candidate) => candidate.key === field.key));
    return [...selected, ...required];
  }, [collection]);

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
    if (Object.keys(validation).length > 0) return;

    const payload = moduleRecordPayload(collection, values);
    const update = record ? diffModuleRecordUpdate(record.data, payload, changedFields) : null;
    const outgoing = update?.patch ?? payload;
    if (record && Object.keys(outgoing).length === 0 && update?.unsetFields.length === 0) {
      onClose();
      return;
    }

    setBusy(true);
    setSubmitError(null);
    try {
      await onSubmit(outgoing, idempotencyKey, update?.unsetFields ?? []);
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
      description={`Fields are defined by the ${collection.name} module schema.`}
      width={620}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-11 rounded-lg px-4 text-[0.8125rem] font-medium disabled:opacity-50"
            style={{ color: 'var(--on-surface-variant)', background: 'var(--surface-container-low)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="module-record-form"
            disabled={busy}
            className="flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-[0.8125rem] font-medium text-white disabled:opacity-60"
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
            role="alert"
            className="rounded-lg px-3 py-2 text-[0.8125rem]"
            style={{ color: 'var(--error)', background: 'var(--danger-subtle)' }}
          >
            {submitError}
          </div>
        )}
        {fields.length === 0 ? (
          <div className="rounded-lg px-4 py-5 text-[0.8125rem]" style={{ background: 'var(--surface-container-low)', color: 'var(--outline)' }}>
            This collection has no editable fields.
          </div>
        ) : fields.map((field) => (
          <ModuleFieldInput
            key={field.key}
            field={field}
            value={values[field.key]}
            error={errors[field.key]}
            onChange={(value) => setValue(field.key, value)}
          />
        ))}
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
  onChange,
}: {
  field: ModuleField;
  value: unknown;
  error?: string;
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
  } else if (field.type === 'multi_select') {
    const selected = Array.isArray(value) ? value.map(String) : [];
    control = (
      <div className="grid gap-2 rounded-lg p-2 sm:grid-cols-2" style={inputStyle}>
        {field.options.map((option) => {
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
