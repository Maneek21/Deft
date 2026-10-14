// Historical native-mailbox callers keep their original names and exact bytes.
export {
 parseCalendarInvitations as parseEmailCalendarInvitations,
 selectInvitationAttendee as selectEmailInvitationAttendee,
 compareInvitationVersion as compareEmailInvitationVersion,
 calendarInvitationIdentity as emailCalendarInvitationIdentity,
 serializeInvitationReply as serializeEmailInvitationReply,
 type CalendarTime as EmailCalendarTime,
 type CalendarAttendee as EmailCalendarAttendee,
 type CalendarInvitation as EmailCalendarInvitation,
 type CalendarInvitationParse as EmailCalendarInvitationParse,
} from './calendar-invitation.js';
