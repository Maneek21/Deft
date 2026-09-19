import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseSupportedDeftModuleManifest } from '../../shared/src/modules.js';
import {
  DeftModuleSemanticValidationError,
  prepareModuleArtifact,
  validateDeftModuleManifest,
} from '../dist/index.js';
import {
  moduleSemanticNegativeCorpus,
  validEquipmentModule,
} from './fixtures/module-semantic-negative-corpus.js';

describe('portable authoritative Module validation', () => {
  test('accepts the unrelated equipment fixture in Kit and host validation', () => {
    assert.doesNotThrow(() => parseSupportedDeftModuleManifest(validEquipmentModule));
    assert.equal(validateDeftModuleManifest(validEquipmentModule).success, true);
  });

  for (const corpusCase of moduleSemanticNegativeCorpus) {
    test(`rejects ${corpusCase.name} with host parity and actionable location`, async () => {
      const manifest = structuredClone(validEquipmentModule) as Record<string, any>;
      corpusCase.mutate(manifest);

      assert.throws(
        () => parseSupportedDeftModuleManifest(manifest),
        undefined,
        'the authoritative host schema must reject the corpus item',
      );
      const result = validateDeftModuleManifest(manifest, {
        artifactPath: 'modules/equipment/deft.module.json',
      });
      assert.equal(result.success, false, 'the packed Kit contract must agree with the host');
      if (result.success) return;
      assert.ok(result.issues.length > 0);
      assert.equal(result.issues[0]?.artifact_path, 'modules/equipment/deft.module.json');
      assert.match(result.issues.map((issue) => issue.field_path).join('\n'), corpusCase.expectedPath);
      assert.ok(result.issues.every((issue) => issue.reason.length > 0));
      assert.ok(result.issues.every((issue) => issue.correction.length > 0));

      await assert.rejects(
        prepareModuleArtifact({
          path: 'modules/equipment/deft.module.json',
          manifest,
        }),
        (error: unknown) => error instanceof DeftModuleSemanticValidationError
          && error.issues[0]?.artifact_path === 'modules/equipment/deft.module.json',
      );
    });
  }
});
