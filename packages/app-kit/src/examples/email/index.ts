export * from './sandbox.js';
export * from './safe-compose-html.js';
export * from './mailbox-list.js';
export * from './native-compose-raster.js';
export {initializeConnected} from './templates.js';
import {checkDeftAppDeveloperContract as checkCore} from '../../core.js';
import {SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS as vectors,SandboxEmailSendInputSchema,SandboxEmailSendOutputSchema} from './sandbox.js';
/** @deprecated Use checkDeftAppDeveloperContract from `@deft/app-kit/core`; use explicit example conformance data when needed. Removal: next breaking Kit alpha. */
export async function checkDeftAppDeveloperContract(input:Parameters<typeof checkCore>[0]) {return {...await checkCore(input),sandbox_email_conformance:{schema:vectors.schema,valid_input:SandboxEmailSendInputSchema.parse(vectors.valid.input),expected_output:SandboxEmailSendOutputSchema.parse(vectors.valid.output)}};}
