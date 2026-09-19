# Try Contacts CRM with fictional data

These CSVs are optional demonstration data for Contacts 1.8.0. Import them through the product after installing Contacts or activating the Contacts CRM App. Importing creates records only; it does not contact anyone, create native tasks, or configure an email connector. All email addresses use reserved `.test` domains.

## Load the sample workspace

Open each collection, choose **Import CSV**, select its file, review the automatically matched columns, then choose **Preview import**. Confirm only the new records. Use Email as the duplicate key for Contacts and Name (Subject for Activities) for the other collections.

| Collection | File | Rows |
|---|---|---:|
| Companies | [companies.csv](companies.csv) | 8 |
| Contacts | [contacts.csv](contacts.csv) | 60 |
| Deals | [deals.csv](deals.csv) | 12 |
| Activities | [activities.csv](activities.csv) | 6 |
| Outreach | [outreach.csv](outreach.csv) | 2 |

The files deliberately omit database IDs, owners and relationship fields. Import them into any workspace; link relationships through the record editor afterward. Reimporting with the same duplicate key skips existing and archived matches without overwriting them. Tags use semicolons; `crm-demo` identifies sample contacts, companies and deals.

The scenario uses September 2026 dates to cover old, overdue, future and undated work. Adjust a deal's close date to your current day when demonstrating Today or Upcoming views.

## Connect one complete relationship

1. Open **Avery Chen**. Edit Company to **Northstar Studio**. Open Northstar Studio and confirm Avery appears in its people list. Leave Legacy company name empty: the Company relation is the canonical identity.
2. Open **Northstar Studio — Pilot**. Link Company to Northstar Studio and Primary contact to Avery Chen. Choose an owner. Move it from Lead to Qualified; inspect the value and currency. Pipeline totals keep USD, EUR and INR separate.
3. Link **Northstar discovery call** and **Northstar original introduction** to Avery and Northstar Studio. Their completed dates populate recorded contact history. The planned, cancelled and undated samples demonstrate why those entries do not count as completed contact.
4. From Avery, choose **Follow-up**. Choose a native Tasks project, assign a teammate and set a due date. If no project exists, create one in Tasks first. Find the task in the follow-up queue, progress it to In Progress, then Done in Tasks. Check that the contact and queue update.
5. Open **Northstar pilot invitation** and link Avery as recipient. Review recipient and content. If a sandbox email capability is configured and reviewed for the App, submit the action, review the message in Inbox, and inspect Action history and receipts afterward. Execution success is not proof of customer email delivery; this demo uses a sandbox only.

## Exercise repair, duplicates and recovery

After importing contacts, import [repair-practice.csv](repair-practice.csv). Preview should show one invalid email and one existing match. Edit the first email cell to `repair@example.test`, preview again, and import the one new row. Avery's existing data should remain unchanged.

For merge practice, create a second contact with Avery's email, use **Review duplicates**, choose which record to retain, inspect conflicts and confirm the merge. The survivor retains linked work and pre-merge action history; original values remain under Merge history. Restoring the absorbed record does not undo transferred links.

Archive the Repair Example contact. Find it under **Archived records**, review its retained data and restore it. Confirm the original ID and values are preserved. No bulk cleanup is required to finish the demonstration.

This is an explicit, manual import walkthrough. It does not automatically seed a fresh installation or link the sample records. Connector setup, live-agent configuration and the complete release-verification gates remain separate requirements.
