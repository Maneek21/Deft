# Compact flagship CRM demo

This is a small, fictional import set for a five-minute Contacts CRM review.
It contains 2 companies, 3 contacts, 3 deals, 2 activities and 1 outreach
draft. Every email uses a reserved `.test` domain. Import each file through the
collection's **Import CSV** action, review the mapped fields, and keep the
`crm-demo` tag.

The files contain no database IDs, owners or relationship fields. After import,
use the record editor to connect Avery Chen and Theo Chen to Northstar Studio,
Mina Chen to Maple Harbor, and connect the deals and activities to their
matching records. Choose the current operator or a teammate as owner in the
editor; create the native follow-up task in Tasks and add the `crm-demo` label.

## Five-minute story

1. Open **Avery Chen** and link **Northstar Studio**. Open **Northstar Studio —
   Pilot**, link its company and primary contact, choose an owner, and move the
   deal from Lead to Qualified.
2. Open **Northstar discovery call**, link Avery and Northstar, and leave its
   outcome Completed. From Avery, create a native follow-up task, assign a
   teammate, and complete it from Tasks. Return through the linked task.
3. Open **Northstar pilot invitation**, link Avery as its recipient, and review
   the exact subject and body. Keep it Draft until the review step.
4. If the reviewed sandbox connector is available, approve the exact message,
   then inspect the App Run and receipt. Say “sandbox accepted”; this fixture
   never sends real email.
5. Use the Maple Harbor rows to show a second account and the closed Northstar
   renewal deal to show active versus won pipeline stages. Archive and restore a
   disposable row if recovery is part of the review.

Importing these files creates records only. It does not seed a workspace, create
native tasks, assign owners, configure a connector or claim customer delivery.
