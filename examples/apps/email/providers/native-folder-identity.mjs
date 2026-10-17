import {digest} from './contract.mjs';

export const GMAIL_CANONICAL_FOLDERS=Object.freeze({INBOX:'inbox',SENT:'sent',SPAM:'spam',TRASH:'trash',DRAFT:'drafts',STARRED:'starred'});
export const gmailFolderId=id=>GMAIL_CANONICAL_FOLDERS[id]??'label:'+digest({kind:'gmail_label_membership_v1',id});
export const microsoftFolderId=(id,systemFolders={})=>Object.hasOwn(systemFolders,id)?systemFolders[id]:'folder:'+digest({kind:'microsoft_folder_membership_v1',id});
export function gmailMessageFolders(labels){
 const folders=[];for(const label of labels)if(GMAIL_CANONICAL_FOLDERS[label]||!['UNREAD','IMPORTANT','CHAT'].includes(label)&&!label.startsWith('CATEGORY_'))folders.push(gmailFolderId(label));
 if(!labels.some(label=>['INBOX','SENT','DRAFT','SPAM','TRASH'].includes(label)))folders.push('archive');return [...new Set(folders)];
}
