// Historical native-mailbox callers retain their names and denial codes.
export {
 assertInvitationReceiver as assertEmailInvitationReceiver,
 projectInvitationAttendees as projectEmailInvitationAttendees,
 type InvitationResponse as EmailInvitationResponse,
} from './calendar-invitation-attendees.js';
