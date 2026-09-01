// The host scheduler and public App Kit simulator intentionally share these
// pure wall-clock rules. Host authority, persistence, claims, and execution
// remain in the API.
export {
  appAutomationLocalDate,
  classifyAppAutomationOccurrence,
  listAppAutomationLogicalDates,
  nextEligibleAppAutomationOccurrence,
  resolveAppAutomationOccurrence,
  type AppAutomationOccurrence,
  type AppAutomationOccurrenceDecision,
} from '@deft/app-kit';
