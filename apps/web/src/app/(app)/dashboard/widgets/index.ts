/**
 * Widget manifest. Importing this module registers every built-in widget.
 * Third-party widgets would call registerWidget() the same way.
 */
import { registerWidget } from '../lib/registry';
import { todayDefinition } from './today';
import { myWorkDefinition } from './my-work';
import { calendarDefinition } from './calendar';
import { unreadDefinition } from './unread';
import { projectsDefinition } from './projects';
import { activityDefinition } from './activity';
import { agentDefinition } from './agent';
import { teamDefinition } from './team';
import { insightsDefinition } from './insights';
import { quickNoteDefinition } from './quick-note';
import { focusDefinition } from './focus';
import { linksDefinition } from './links';
import { reviewDefinition } from './review';
import { agentSuggestionsDefinition } from './agent-suggestions';
import { pinnedDefinition } from './pinned';
import { mentionsDefinition } from './mentions';

let registered = false;

export function registerBuiltInWidgets(): void {
  if (registered) return;
  registered = true;
  // Core widgets (shipped by default in the layout)
  registerWidget(todayDefinition);
  registerWidget(myWorkDefinition);
  registerWidget(calendarDefinition);
  registerWidget(unreadDefinition);
  registerWidget(projectsDefinition);
  registerWidget(activityDefinition);
  registerWidget(agentDefinition);
  registerWidget(teamDefinition);
  registerWidget(insightsDefinition);
  // Extra widgets (added via the Add-widget drawer)
  registerWidget(quickNoteDefinition);
  registerWidget(focusDefinition);
  registerWidget(linksDefinition);
  registerWidget(reviewDefinition);
  registerWidget(agentSuggestionsDefinition);
  registerWidget(pinnedDefinition);
  registerWidget(mentionsDefinition);
}
