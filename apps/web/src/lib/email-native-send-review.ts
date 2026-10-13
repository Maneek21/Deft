import {parseNativeDraftContent,type NativeDraftContent} from './email-native-drafts';
import {parseNativeSafeComposeHtml as parseSafeComposeHtml} from '../../../../packages/app-kit/src/safe-compose-html';
export type EmailSendReviewTarget={actionId:string;accountId:string;draftId:string;draftRevision:number;contentDigest:string};
export type EmailSendReview=EmailSendReviewTarget & {content:NativeDraftContent};
export function parseEmailSendReview(raw:unknown,target:EmailSendReviewTarget):EmailSendReview {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Email review is unavailable.');
  const value=raw as Record<string,unknown>;
  if(value.valid!==true||value.action_id!==target.actionId||value.account_id!==target.accountId||value.draft_id!==target.draftId||value.draft_revision!==target.draftRevision||value.content_digest!==target.contentDigest)throw Error('This email draft changed. Request a new send review.');
  const content=parseNativeDraftContent(value.content);
  if(!content.from_identity||!content.to.trim())throw Error('The exact sender and recipients could not be confirmed.');
  if(content.body_html&&parseSafeComposeHtml(content.body_html).plainText!==content.body)throw Error('Formatting and plain text must match.');
  return {...target,content};
}
