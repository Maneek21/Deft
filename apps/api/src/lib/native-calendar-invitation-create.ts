import {randomUUID} from 'node:crypto';import {and,eq} from 'drizzle-orm';import {events} from '@deft/db/schema';
import type {AppRunTransaction as Tx} from './app-run-repository.js';
import type {EmailCalendarInvitation} from './email-calendar-invitation.js';
import {projectEmailInvitationAttendees,assertEmailInvitationReceiver} from './email-calendar-attendee-projection.js';
export async function createNativeCalendarInvitationEvent(tx:Tx,input:{owner:{org_id:string;user_id:string};invitation:EmailCalendarInvitation;response:'accepted'|'tentative'|'declined'|null;cancel:boolean;receiving_address:string|null;prior_event:typeof events.$inferSelect|null;calendar_metadata:Record<string,unknown>;at:Date}){
 const {owner,invitation,response,cancel,at}=input;let event:typeof events.$inferSelect|null|undefined=input.prior_event;
 const receiver=cancel?null:assertEmailInvitationReceiver(invitation,input.receiving_address);
 const where=(id:string)=>and(eq(events.id,id),eq(events.org_id,owner.org_id),eq(events.user_id,owner.user_id),eq(events.source,'native'),eq(events.event_type,'calendar_event'));
 if(event&&(event.org_id!==owner.org_id||event.user_id!==owner.user_id||event.source!=='native'||event.event_type!=='calendar_event'))throw Error('EMAIL_INVITATION_CALENDAR_DENIED');
 if(cancel||response==='declined'){if(event){const metadata=event.metadata as Record<string,unknown>;[event]=await tx.update(events).set({metadata:{...metadata,status:'canceled',email_invitation_response:response,...(!cancel?{attendees:projectEmailInvitationAttendees(invitation,receiver!,response!)}:{})},updated_at:at}).where(where(event.id)).returning();if(!event)throw Error('EMAIL_INVITATION_CALENDAR_DENIED');}return event;}
 if(!invitation.start||!invitation.end)throw Error('EMAIL_INVITATION_TIME_UNSUPPORTED');
 const instant=(time:NonNullable<EmailCalendarInvitation['start']>)=>time.value_type==='date'?new Date(`${time.value.slice(0,4)}-${time.value.slice(4,6)}-${time.value.slice(6,8)}T00:00:00Z`):new Date(time.instant!);
 const beginning=instant(invitation.start),ending=instant(invitation.end);if(!Number.isFinite(beginning.getTime())||!Number.isFinite(ending.getTime())||ending<=beginning)throw Error('EMAIL_INVITATION_TIME_UNSUPPORTED');
 const reported:Record<string,string>={ACCEPTED:'accepted',DECLINED:'declined',TENTATIVE:'tentative','NEEDS-ACTION':'needsAction'};
 const attendees=response?projectEmailInvitationAttendees(invitation,receiver!,response):invitation.attendees.map(row=>({email:row.address,displayName:row.name||row.address,responseStatus:reported[row.partstat]??'needsAction'}));
 const metadata={...input.calendar_metadata,start:beginning.toISOString(),end:ending.toISOString(),location:invitation.location||null,attendees,hangoutLink:null,status:response==='tentative'?'tentative':'confirmed',allDay:invitation.start.value_type==='date',email_invitation_response:response};
 if(event){[event]=await tx.update(events).set({title:invitation.summary,body:invitation.description||null,timestamp:beginning,metadata,updated_at:at}).where(where(event.id)).returning();}
 else{[event]=await tx.insert(events).values({id:randomUUID(),org_id:owner.org_id,user_id:owner.user_id,source:'native',event_type:'calendar_event',external_id:null,title:invitation.summary,body:invitation.description||null,actor:invitation.organizer.address,timestamp:beginning,metadata,created_at:at,updated_at:at}).returning();}if(!event)throw Error('EMAIL_INVITATION_CALENDAR_DENIED');return event;
}
