export const DEFT_MODULE_MANIFEST_FILENAME: 'deft.module.json';
export const DEFT_MODULE_MANIFEST_SCHEMA_VERSION: '1';
export const DEFT_MODULE_MANIFEST_SCHEMA_VERSION_V2: '2';

export type PortableModuleSchemaIssue = {
  path: PropertyKey[];
  message: string;
};

export const DeftModuleManifestSchema: {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: PortableModuleSchemaIssue[] } };
};
