// Unmigrated alpha.38/39 consumer entry points must compile during transition.
import {parseMailboxList,formatNativeMailboxList,parseNativeMailboxList,
 parseSafeComposeHtml,safeComposeHtmlFromEditorDocument,plainTextToSafeComposeHtml,
 SandboxEmailSendInputSchema,SandboxEmailSendOutputSchema,SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE,
 APP_AUTOMATION_POLICY_V1,type MailboxAddress,type MailboxListOptions,type SafeComposeDocument,
 type SandboxEmailSendInput,type SandboxEmailSendOutput} from '@deft/app-kit';
import {parseNativeSafeComposeHtml,nativeComposeImageCid,nativeComposeInlineFileIds,
 removeNativeComposeInlineFiles,canonicalNativeComposeLink,inspectNativeComposeRaster,validateNativeComposeRaster,
 nativeSafeComposeHtmlFromEditorDocument,nativeComposeDraftFromEditorDocument,NATIVE_COMPOSE_BODY_LIMITS,
 plainTextToNativeComposeHtml,type NativeComposeOptions,type NativeComposeInlineAttachment,
 type NativeComposeRasterInfo,type NativeComposeRasterProfile} from '@deft/app-kit/experience';
const options:MailboxListOptions={maxItems:1};
const addresses:readonly MailboxAddress[]=parseMailboxList('a@example.test',options);
formatNativeMailboxList(parseNativeMailboxList(addresses[0]!.address));
const basic:SafeComposeDocument=parseSafeComposeHtml(plainTextToSafeComposeHtml('Hello'));
safeComposeHtmlFromEditorDocument({type:'doc',content:[]});
const inline:NativeComposeInlineAttachment[]=[];const richOptions:NativeComposeOptions={inlineAttachments:inline};
parseNativeSafeComposeHtml(plainTextToNativeComposeHtml(basic.plainText),richOptions);
const id='11111111-1111-4111-8111-111111111111';nativeComposeImageCid(id);
nativeComposeInlineFileIds('',richOptions);removeNativeComposeInlineFiles('',[],richOptions);
canonicalNativeComposeLink('https://example.test/');nativeSafeComposeHtmlFromEditorDocument({type:'doc'});
nativeComposeDraftFromEditorDocument({type:'doc'});void NATIVE_COMPOSE_BODY_LIMITS;
const profile:NativeComposeRasterProfile='received';const raster:NativeComposeRasterInfo|null=inspectNativeComposeRaster(new Uint8Array(), 'image/png',profile);
validateNativeComposeRaster(new Uint8Array(),'image/png',profile);void raster;
const input:SandboxEmailSendInput=SandboxEmailSendInputSchema.parse({});
const output:SandboxEmailSendOutput=SandboxEmailSendOutputSchema.parse({});void [input,output,SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE,APP_AUTOMATION_POLICY_V1];
