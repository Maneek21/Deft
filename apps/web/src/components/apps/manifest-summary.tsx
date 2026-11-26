'use client';

import { useId } from 'react';
import type { DeftModuleManifest } from '@deft/shared/modules';
import { describeModuleManifest } from '@/lib/module-describe';

export type ManifestSummaryProps = {
  manifest: DeftModuleManifest;
  /** Whether the person said Defty may read these records. Default no. */
  agentRead?: boolean;
  /** Shows the "Let Defty read these records?" question when given. */
  onAgentReadChange?: (agentRead: boolean) => void;
  /** Heading level for each record type, to fit the page around it. Default 3. */
  headingLevel?: 2 | 3 | 4;
};

const muted = { color: 'var(--on-surface-variant)' } as const;

/**
 * What an app adds, in plain words, before it is installed: each record type,
 * its fields, links and views, and who can see the records. Optionally asks
 * whether Defty may read them; the caller sends `agent_access: read` after
 * install when the answer is yes (see `agentAccessPatchFor`).
 */
export function ManifestSummary({ manifest, agentRead = false, onAgentReadChange, headingLevel = 3 }: ManifestSummaryProps) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const description = describeModuleManifest(manifest);
  const questionId = useId();
  return (
    <section aria-label={`What ${description.name} adds`} className="space-y-4 text-sm">
      <p className="leading-6">{description.summary}</p>
      <ul className="space-y-3">
        {description.collections.map((collection) => (
          <li
            key={collection.key}
            className="rounded-xl border p-3"
            style={{ borderColor: 'var(--ghost-border)', background: 'var(--surface-container-low)' }}
          >
            <Heading className="font-semibold">{collection.summary}</Heading>
            {collection.fields.length > 0 ? (
              <div className="mt-2">
                <p className="text-xs font-medium" style={muted}>Fields</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 leading-6">
                  {collection.fields.map((field, index) => <li key={`field-${index}`}>{field}</li>)}
                </ul>
              </div>
            ) : null}
            {collection.relations.length > 0 ? (
              <div className="mt-2">
                <p className="text-xs font-medium" style={muted}>Links</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 leading-6">
                  {collection.relations.map((relation, index) => <li key={`relation-${index}`}>{relation}</li>)}
                </ul>
              </div>
            ) : null}
            {collection.views.length > 0 ? (
              <div className="mt-2">
                <p className="text-xs font-medium" style={muted}>Views</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 leading-6">
                  {collection.views.map((view, index) => <li key={`view-${index}`}>{view}</li>)}
                </ul>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="leading-6" style={muted}>{description.access}</p>
      {onAgentReadChange ? (
        <AgentReadQuestion idBase={questionId} agentRead={agentRead} onAgentReadChange={onAgentReadChange} />
      ) : null}
    </section>
  );
}

/** The install-time question. Default no; Yes means `agent_access: read`. */
export function AgentReadQuestion({ idBase, agentRead, onAgentReadChange }: {
  idBase: string;
  agentRead: boolean;
  onAgentReadChange: (agentRead: boolean) => void;
}) {
  return (
    <fieldset className="space-y-2" aria-describedby={`${idBase}-help`}>
      <legend className="font-medium">Let Defty read these records?</legend>
      <p id={`${idBase}-help`} className="text-xs leading-5" style={muted}>
        Defty can then find and answer questions about them. It can&apos;t change them. You can change this later on the app&apos;s card.
      </p>
      <div className="flex flex-wrap gap-4">
        <label className="inline-flex min-h-11 items-center gap-2">
          <input
            type="radio"
            name={`${idBase}-agent-read`}
            value="no"
            checked={!agentRead}
            onChange={() => onAgentReadChange(false)}
          />
          No
        </label>
        <label className="inline-flex min-h-11 items-center gap-2">
          <input
            type="radio"
            name={`${idBase}-agent-read`}
            value="yes"
            checked={agentRead}
            onChange={() => onAgentReadChange(true)}
          />
          Yes, let Defty read them
        </label>
      </div>
    </fieldset>
  );
}
