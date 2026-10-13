import {selectEmailInvitationAttendee,type EmailCalendarInvitation} from './email-calendar-invitation.js';

export type EmailInvitationResponse='accepted'|'tentative'|'declined';
/** The receiver is an internal nomination from fresh host preview authority,
 * never an HTTP field. Membership must remain exactly one before any write. */
export function assertEmailInvitationReceiver(invitation:EmailCalendarInvitation,receiver:string|null):string{
 const selected=typeof receiver==='string'?selectEmailInvitationAttendee(invitation,[receiver]):null;
 if(!selected||selected.address!==receiver)throw Error('EMAIL_INVITATION_INVALID');
 return selected.address;
}
/** Preserve reported other-attendee participation; only the verified receiver
 * gets this owner's chosen local response. Delivery remains a separate state. */
export function projectEmailInvitationAttendees(invitation:EmailCalendarInvitation,receiver:string,response:EmailInvitationResponse){
 assertEmailInvitationReceiver(invitation,receiver);
 if(!['accepted','tentative','declined'].includes(response))throw Error('EMAIL_INVITATION_INVALID');
 const reported:Record<string,string>={ACCEPTED:'accepted',DECLINED:'declined',TENTATIVE:'tentative','NEEDS-ACTION':'needsAction'};
 return invitation.attendees.map(row=>({email:row.address,displayName:row.name||row.address,
  responseStatus:row.address===receiver?response:reported[row.partstat]??'needsAction'}));
}
